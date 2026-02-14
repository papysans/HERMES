#!/usr/bin/env node
/**
 * Permission Listener — 独立 Node.js 进程
 *
 * 通过 Telegram Bot API getUpdates 长轮询接收 callback_query，
 * 解析用户点击的 RUN/ALWAYS/REJECT 按钮，调用 OpenCode 权限 API。
 *
 * 环境变量:
 *   HERMES_PERMISSION_BOT_TOKEN  - Permission Bot 令牌（必填）
 *   HERMES_OPENCODE_PORT         - OpenCode 端口（默认 4096）
 *   HERMES_TELEGRAM_CHANNEL      - 群组 ID（默认 -5088310983）
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { getPending, removePending, cleanExpired, updatePending, loadStore, QUESTION_TTL_MS } from './pending-store.js';
import {
    loadControlState,
    setMode,
    setSelectedAgent,
    setSelectedSkillProfile,
    startTakeover,
    stopTakeover,
    markBlocked,
    markProgress,
    buildTaskEnvelope,
    inferSkillProfile,
    skillProfileToSkill,
    HERMES_SKILL_PROFILES
} from './control-state.js';
// Note: when run from plugins/lib/, this resolves to plugins/lib/pending-store.js (same directory)

const BOT_TOKEN = process.env.HERMES_PERMISSION_BOT_TOKEN;
const OPENCODE_PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const TELEGRAM_CHANNEL = process.env.HERMES_TELEGRAM_CHANNEL || '-5088310983';
const STALL_TIMEOUT_MS = Number(process.env.HERMES_STALL_TIMEOUT_MS || 90_000);
const STALL_RETRY_LIMIT = Number(process.env.HERMES_STALL_RETRY_LIMIT || 1);
const OHMY_CONFIG_PATH = process.env.HERMES_OHMY_CONFIG || `${homedir()}/.config/opencode/oh-my-opencode.json`;
const DEFAULT_AGENT = 'sisyphus';
const AUTO_APPROVE_LOW_RISK_MODE = String(process.env.HERMES_AUTO_APPROVE_LOW_RISK_MODE || 'delegate').toLowerCase();

let offset = 0;
let running = true;

// --- Pure functions (exported for testing) ---

export function parseCallbackData(callbackData) {
    if (!callbackData || typeof callbackData !== 'string') return null;
    const idx = callbackData.indexOf(':');
    if (idx === -1) return null;
    const action = callbackData.slice(0, idx);
    const uniqueId = callbackData.slice(idx + 1);
    if (!action || !uniqueId) return null;
    return { action, uniqueId };
}

export function actionToResponse(action) {
    const map = { run: 'once', always: 'always', reject: 'reject' };
    return map[action] || null;
}

export function isQuestionCallback(callbackData) {
    if (!callbackData || typeof callbackData !== 'string') return false;
    return callbackData.startsWith('qopt:') || callbackData.startsWith('qcustom:');
}

export function buildControlResponseBody(answer) {
    return { body: String(answer) };
}

export function buildControlResponseUrl(port) {
    return `http://localhost:${port}/tui/control/response`;
}

export function buildPromptAsyncUrl(port, sessionId) {
    return `http://localhost:${port}/session/${sessionId}/prompt_async`;
}

export function parseQuestionCallback(callbackData) {
    if (!callbackData || typeof callbackData !== 'string') return null;
    if (callbackData.startsWith('qopt:')) {
        const parts = callbackData.slice(5).split(':');
        if (parts.length !== 2) return null;
        const [uniqueId, indexStr] = parts;
        const optionIndex = parseInt(indexStr, 10);
        if (isNaN(optionIndex)) return null;
        return { type: 'option', uniqueId, optionIndex };
    }
    if (callbackData.startsWith('qcustom:')) {
        const uniqueId = callbackData.slice(8);
        if (!uniqueId) return null;
        return { type: 'custom', uniqueId };
    }
    return null;
}

export function parseControlCallback(callbackData) {
    if (!callbackData || typeof callbackData !== 'string') return null;
    if (callbackData.startsWith('hmode:')) {
        return { type: 'mode', value: callbackData.slice('hmode:'.length) };
    }
    if (callbackData.startsWith('hagent:')) {
        return { type: 'agent', value: callbackData.slice('hagent:'.length) };
    }
    if (callbackData.startsWith('hskill:')) {
        return { type: 'skill', value: callbackData.slice('hskill:'.length) };
    }
    return null;
}

function stripOuterBrackets(text) {
    if (!text) return '';
    const s = String(text).trim();
    if ((s.startsWith('（') && s.endsWith('）')) || (s.startsWith('(') && s.endsWith(')'))) {
        return s.slice(1, -1).trim();
    }
    return s;
}

function resolveModeAlias(input) {
    const raw = String(input || '').trim().toLowerCase();
    const map = {
        forward: 'forward',
        '转发': 'forward',
        copilot: 'copilot',
        '协同': 'copilot',
        delegate: 'delegate',
        '代决策': 'delegate'
    };
    return map[raw] || null;
}

export function parseControlCommand(rawText) {
    const inner = stripOuterBrackets(rawText);
    if (!inner) return null;

    let m = inner.match(/^模式\s*[:：]\s*(.+)$/i);
    if (!m) m = inner.match(/^mode\s*[:：]\s*(.+)$/i);
    if (m) {
        const mode = resolveModeAlias(m[1]);
        if (!mode) return { type: 'invalid_mode', raw: m[1] };
        return { type: 'set_mode', mode };
    }

    m = inner.match(/^接管\s*[:：]\s*(.+)$/i);
    if (!m) m = inner.match(/^takeover\s*[:：]\s*(.+)$/i);
    if (m) {
        const goal = String(m[1] || '').trim();
        if (!goal) return null;
        return { type: 'start_takeover', goal };
    }

    if (/^停止接管$/i.test(inner) || /^stop\s*takeover$/i.test(inner)) {
        return { type: 'stop_takeover' };
    }

    if (/^选择\s*agent$/i.test(inner) || /^选择agent$/i.test(inner) || /^select\s*agent$/i.test(inner)) {
        return { type: 'select_agent' };
    }

    m = inner.match(/^切换\s*agent\s*[:：]\s*([a-zA-Z0-9_-]+)$/i);
    if (!m) m = inner.match(/^set\s*agent\s*[:：]\s*([a-zA-Z0-9_-]+)$/i);
    if (!m) m = inner.match(/^agent\s*[:：]\s*([a-zA-Z0-9_-]+)$/i);
    if (m) {
        return { type: 'set_agent', agent: m[1] };
    }

    m = inner.match(/^skill\s*[:：]\s*([a-zA-Z0-9_-]+)$/i);
    if (m) {
        const profile = m[1].toLowerCase();
        if (!isValidSkillProfile(profile)) {
            return { type: 'invalid_skill', raw: profile };
        }
        return { type: 'set_skill', profile };
    }

    return null;
}

function loadOhMyAgentKeys() {
    try {
        if (!existsSync(OHMY_CONFIG_PATH)) return [DEFAULT_AGENT];
        const parsed = JSON.parse(readFileSync(OHMY_CONFIG_PATH, 'utf-8'));
        const keys = Object.keys(parsed?.agents || {});
        if (!Array.isArray(keys) || keys.length === 0) return [DEFAULT_AGENT];
        return keys.sort((a, b) => a.localeCompare(b));
    } catch {
        return [DEFAULT_AGENT];
    }
}

function prettyMode(mode) {
    const map = { forward: '转发', copilot: '协同', delegate: '代决策' };
    return map[mode] || mode;
}

function prettyProfile(profile) {
    const map = {
        plan: 'plan',
        execute: 'execute',
        debug: 'debug',
        review: 'review'
    };
    return map[profile] || profile;
}

function isValidSkillProfile(profile) {
    return HERMES_SKILL_PROFILES.includes(String(profile || '').trim().toLowerCase());
}


function withDirectory(url, directory) {
    if (!directory) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}directory=${encodeURIComponent(directory)}`;
}

function buildQuestionListUrl(port, directory) {
    return withDirectory(`http://localhost:${port}/question`, directory);
}

function buildQuestionReplyUrl(port, requestId, directory) {
    return withDirectory(`http://localhost:${port}/question/${requestId}/reply`, directory);
}

function buildQuestionRejectUrl(port, requestId, directory) {
    return withDirectory(`http://localhost:${port}/question/${requestId}/reject`, directory);
}

function normalizeGroupAnswerText(text) {
    if (text == null) return '';
    let out = String(text).trim();
    // 支持群组中以 @bot 前缀发送答案，例如：@Napsta6100ks_bot echo hello
    out = out.replace(/^@\S+\s+/, '');
    return out.trim();
}

async function fetchQuestionList(directory) {
    const url = buildQuestionListUrl(OPENCODE_PORT, directory);
    const res = await fetch(url);
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`question list ${res.status} ${errText}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

function matchQuestionRequest(questions, pending) {
    if (pending.requestID) {
        return questions.find(q => q.id === pending.requestID) || null;
    }

    if (pending.callID) {
        const byCall = questions.find(q => q.tool?.callID === pending.callID);
        if (byCall) return byCall;
    }

    if (pending.sid) {
        const bySession = questions.filter(q => q.sessionID === pending.sid);
        if (bySession.length === 1) return bySession[0];
    }

    return null;
}

async function resolveQuestionRequest(pending, { retries = 20, intervalMs = 300 } = {}) {
    for (let i = 0; i < retries; i++) {
        const questions = await fetchQuestionList(pending.directory);
        const matched = matchQuestionRequest(questions, pending);
        if (matched) return matched;
        if (i < retries - 1) await sleep(intervalMs);
    }
    return null;
}

async function replyQuestion(pending, answerValue) {
    const matched = await resolveQuestionRequest(pending);
    if (!matched) {
        throw new Error('未找到匹配的 question requestID');
    }

    const url = buildQuestionReplyUrl(OPENCODE_PORT, matched.id, pending.directory);
    const payload = {
        answers: [[String(answerValue)]]
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`question reply ${res.status} ${errText}`);
    }
    return matched.id;
}

async function rejectQuestion(pending) {
    const matched = await resolveQuestionRequest(pending, { retries: 2, intervalMs: 200 });
    if (!matched) return false;
    const url = buildQuestionRejectUrl(OPENCODE_PORT, matched.id, pending.directory);
    const res = await fetch(url, { method: 'POST' });
    return res.ok;
}


// --- Telegram API helpers ---

async function telegramApi(method, payload) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Telegram ${method} HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Telegram ${method} API error: ${data.description || 'unknown'}`);
    }
    return data.result;
}

async function answerCallback(queryId, text) {
    await telegramApi('answerCallbackQuery', { callback_query_id: queryId, text });
}

async function editMessageResult(chatId, messageId, originalText, result) {
    await telegramApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `${originalText}\n\n---\n${result}`
    });
    await telegramApi('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
    });
}

async function editExpiredMessage(chatId, messageId) {
    try {
        await telegramApi('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    } catch (err) {
        console.warn('[PermListener] 编辑过期消息失败:', err.message);
    }
}

async function sendErrorMessage(chatId, text) {
    await telegramApi('sendMessage', { chat_id: chatId, text });
}

async function sendInfoMessage(chatId, text) {
    await telegramApi('sendMessage', { chat_id: chatId, text });
}

async function sendForceReplyPrompt(chatId, text) {
    const result = await telegramApi('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: {
            force_reply: true,
            selective: false
        }
    });
    return result?.message_id ?? null;
}

async function sendKeyboardMessage(chatId, text, keyboard) {
    await telegramApi('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: keyboard
    });
}

function buildModeInlineKeyboard(currentMode) {
    const modeRows = [
        { key: 'forward', label: '转发' },
        { key: 'copilot', label: '协同' },
        { key: 'delegate', label: '代决策' }
    ].map(item => [{
        text: `${currentMode === item.key ? '✅ ' : ''}${item.label}`,
        callback_data: `hmode:${item.key}`
    }]);
    return { inline_keyboard: modeRows };
}

function buildAgentInlineKeyboard(agents, selectedAgent) {
    const rows = agents.map(agent => [{
        text: `${selectedAgent === agent ? '✅ ' : ''}${agent}`,
        callback_data: `hagent:${agent}`
    }]);
    return { inline_keyboard: rows };
}

function buildSkillInlineKeyboard(selectedProfile) {
    const profiles = [
        { key: 'plan', skill: 'superpowers/writing-plans' },
        { key: 'execute', skill: 'superpowers/executing-plans' },
        { key: 'debug', skill: 'superpowers/systematic-debugging' },
        { key: 'review', skill: 'superpowers/requesting-code-review' }
    ];
    return {
        inline_keyboard: profiles.map(p => [{
            text: `${selectedProfile === p.key ? '✅ ' : ''}${p.key}`,
            callback_data: `hskill:${p.key}`
        }])
    };
}

export function assessPermissionRisk(command) {
    if (!command) return 'low';
    const cmd = String(command).trim().toLowerCase();
    if (!cmd) return 'low';

    // Shell 控制符、重定向、命令替换统一视为高风险，避免封装命令绕过。
    if (/[;&|><`]/.test(cmd) || /\$\(/.test(cmd)) return 'high';

    const high = [
        /^rm\s+-rf/,
        /^dd\s+/,
        /^mkfs/,
        /^chmod\s+-r\s+777/,
        /^chown\s+-r/,
        /^format\s+/,
        /^fdisk/,
        /^curl\s+/,
        /^wget\s+/,
        /^nc\s+/,
        /^ssh\s+/
    ];
    const medium = [
        /^rm\s+/,
        /^mv\s+/,
        /^sed\s+-i/,
        /^kill\s+-9/,
        /^pkill/,
        /^killall/,
        /^chmod\s+/,
        /^chown\s+/,
        /^docker\s+/,
        /^npm\s+install/,
        /^bun\s+install/
    ];
    const lowAllowList = [
        /^pwd$/,
        /^whoami$/,
        /^date$/,
        /^ls(\s+[-a-z0-9./_]+)?$/,
        /^echo(\s+.+)?$/,
        /^cat\s+[-a-z0-9./_]+$/,
        /^head(\s+[-a-z0-9./_]+)+$/,
        /^tail(\s+[-a-z0-9./_]+)+$/,
        /^wc(\s+[-a-z0-9./_]+)+$/,
        /^grep(\s+[-a-z0-9./_*]+)+$/,
        /^rg(\s+[-a-z0-9./_*]+)+$/,
        /^node\s+--version$/,
        /^python3?\s+--version$/,
        /^git\s+status(\s+--short)?$/
    ];

    for (const p of high) if (p.test(cmd)) return 'high';
    for (const p of medium) if (p.test(cmd)) return 'medium';
    for (const p of lowAllowList) if (p.test(cmd)) return 'low';
    return 'medium';
}

function shouldAutoApprove(entry, mode) {
    if (!entry || entry.type !== 'permission') return false;
    if (!entry.sid || !entry.pid) return false;
    if (entry.autoApproved || entry.autoRejected || entry.autoTried) return false;
    if (AUTO_APPROVE_LOW_RISK_MODE === 'off') return false;
    if (AUTO_APPROVE_LOW_RISK_MODE !== 'any' && mode !== AUTO_APPROVE_LOW_RISK_MODE) return false;
    return assessPermissionRisk(entry.command) === 'low';
}

async function autoApproveLowRiskPermissions() {
    const state = loadControlState();
    const mode = String(state.mode || '');
    const store = loadStore();
    const entries = Object.entries(store);
    if (entries.length === 0) return;

    for (const [uniqueId, entry] of entries) {
        if (!shouldAutoApprove(entry, mode)) continue;
        updatePending(uniqueId, { autoTried: true, autoTriedAt: Date.now() });
        try {
            const apiRes = await fetch(
                `http://localhost:${OPENCODE_PORT}/session/${entry.sid}/permissions/${entry.pid}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: 'once' })
                }
            );

            if (!apiRes.ok) {
                const errText = await apiRes.text().catch(() => '');
                updatePending(uniqueId, {
                    autoApproveError: `status=${apiRes.status} ${errText}`,
                    autoApproveAt: Date.now()
                });
                continue;
            }

            if (entry.chatId && entry.messageId) {
                await editExpiredMessage(entry.chatId, entry.messageId);
            }
            removePending(uniqueId);
            await sendInfoMessage(
                TELEGRAM_CHANNEL,
                `🤖 已自动批准低风险权限（mode=${mode}）\n命令: ${entry.command || '(unknown)'}`
            );
        } catch (err) {
            updatePending(uniqueId, {
                autoApproveError: String(err?.message || err),
                autoApproveAt: Date.now()
            });
        }
    }
}

async function getSessionList() {
    const res = await fetch(`http://localhost:${OPENCODE_PORT}/session`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

async function createSession(title) {
    const res = await fetch(`http://localhost:${OPENCODE_PORT}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || 'Hermes takeover session' })
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`create session ${res.status} ${errText}`);
    }
    const data = await res.json();
    return data?.id || '';
}

async function ensureActiveSessionId(current) {
    const sessions = await getSessionList();
    if (current && sessions.some(s => s?.id === current)) return current;
    if (sessions.length > 0 && sessions[0]?.id) return sessions[0].id;
    return createSession('Hermes takeover');
}

async function sendPromptAsync(sessionId, text, agent) {
    const url = buildPromptAsyncUrl(OPENCODE_PORT, sessionId);
    const payload = {
        parts: [{ type: 'text', text }]
    };
    if (agent) payload.agent = String(agent);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok && res.status !== 204) {
        const errText = await res.text().catch(() => '');
        throw new Error(`prompt_async ${res.status} ${errText}`);
    }
}

async function dispatchTakeoverGoal(goal, reason = 'start') {
    const state = loadControlState();
    const sessionId = await ensureActiveSessionId(state.activeSessionId);
    const profile = state.selectedSkillProfile || inferSkillProfile(goal);
    const envelope = buildTaskEnvelope({
        mode: state.mode,
        selectedAgent: state.selectedAgent,
        selectedSkillProfile: profile,
        goal
    });
    await sendPromptAsync(sessionId, envelope, state.selectedAgent || DEFAULT_AGENT);
    return markProgress(sessionId, {
        selectedSkillProfile: profile,
        selectedAgent: state.selectedAgent || DEFAULT_AGENT,
        takeoverGoal: goal,
        takeoverActive: true,
        lastDispatchReason: reason
    });
}

async function notifyStall(text) {
    console.warn(`[PermListener] ⚠️ ${text}`);
    await sendInfoMessage(TELEGRAM_CHANNEL, `⚠️ ${text}`);
}

function hasPendingWorkForSession(sessionId) {
    if (!sessionId) return false;
    const now = Date.now();
    const store = loadStore();
    return Object.values(store).some((entry) => {
        if (!entry || entry.sid !== sessionId) return false;
        if (entry.type === 'permission') return true;
        if (entry.type === 'question') {
            if (entry.answer !== undefined) return false;
            const age = now - Number(entry.timestamp || 0);
            return age < QUESTION_TTL_MS;
        }
        return false;
    });
}

async function checkTakeoverStall() {
    const state = loadControlState();
    if (!state.takeoverActive) return;
    if (!state.takeoverGoal) return;
    if (!state.lastProgressAt) return;
    if (hasPendingWorkForSession(state.activeSessionId)) return;

    const age = Date.now() - Number(state.lastProgressAt);
    if (age < STALL_TIMEOUT_MS) return;

    if (state.blocked) return;

    if (Number(state.retryCount || 0) < STALL_RETRY_LIMIT) {
        try {
            const next = await dispatchTakeoverGoal(state.takeoverGoal, 'retry');
            const retryCount = Number(state.retryCount || 0) + 1;
            markProgress(next.activeSessionId || state.activeSessionId, {
                retryCount,
                retryAt: Date.now(),
                takeoverActive: true,
                takeoverGoal: state.takeoverGoal
            });
            await notifyStall(`接管任务 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒无进展，已自动重投一次（retry=${retryCount}/${STALL_RETRY_LIMIT}）`);
        } catch (err) {
            markBlocked(`stall_retry_failed: ${err.message}`, {
                blockedAt: Date.now()
            });
            await notifyStall(`接管任务卡住且重投失败：${err.message}`);
        }
        return;
    }

    markBlocked('stall_timeout', { blockedAt: Date.now() });
    await notifyStall('Agent 可能卡住，请你决定是否切换或重试。');
}

async function handleControlCallback(query) {
    const { data: callbackData, id: queryId, message } = query;
    const parsed = parseControlCallback(callbackData);
    if (!parsed) return false;

    if (parsed.type === 'mode') {
        const mode = resolveModeAlias(parsed.value);
        if (!mode) {
            await answerCallback(queryId, '模式无效');
            return true;
        }
        setMode(mode);
        await answerCallback(queryId, `已切换到 ${prettyMode(mode)} 模式`);
        await sendInfoMessage(message.chat.id, `🧭 当前模式：${prettyMode(mode)} (${mode})`);
        return true;
    }

    if (parsed.type === 'agent') {
        const target = String(parsed.value || '').trim();
        const agents = loadOhMyAgentKeys();
        if (!agents.includes(target)) {
            await answerCallback(queryId, `未知 Agent: ${target}`);
            await sendErrorMessage(message.chat.id, `未知 Agent: ${target}\n可选: ${agents.join(', ')}`);
            return true;
        }
        setSelectedAgent(target);
        await answerCallback(queryId, `已选择 Agent: ${target}`);
        await sendInfoMessage(message.chat.id, `🤖 当前 Agent：${target}`);
        return true;
    }

    if (parsed.type === 'skill') {
        const profile = String(parsed.value || '').trim().toLowerCase();
        if (!isValidSkillProfile(profile)) {
            await answerCallback(queryId, `无效 skill: ${profile}`);
            await sendErrorMessage(message.chat.id, `未知 skill profile: ${profile}\n可选: ${HERMES_SKILL_PROFILES.join(', ')}`);
            return true;
        }
        setSelectedSkillProfile(profile);
        await answerCallback(queryId, `已选择 skill profile: ${profile}`);
        await sendInfoMessage(message.chat.id, `🧠 当前 skill profile：${prettyProfile(profile)} (${skillProfileToSkill(profile)})`);
        return true;
    }

    return false;
}

async function handleControlTextCommand(msg, normalizedText) {
    const cmd = parseControlCommand(normalizedText);
    if (!cmd) return false;

    if (cmd.type === 'invalid_mode') {
        await sendErrorMessage(msg.chat.id, `未知模式: ${cmd.raw}\n可选: 转发 / 协同 / 代决策`);
        return true;
    }

    if (cmd.type === 'invalid_skill') {
        await sendErrorMessage(msg.chat.id, `未知 skill profile: ${cmd.raw}\n可选: ${HERMES_SKILL_PROFILES.join(', ')}`);
        return true;
    }

    if (cmd.type === 'set_mode') {
        setMode(cmd.mode);
        await sendInfoMessage(msg.chat.id, `🧭 已切换模式：${prettyMode(cmd.mode)} (${cmd.mode})`);
        await sendKeyboardMessage(
            msg.chat.id,
            '可随时通过按钮切换模式：',
            buildModeInlineKeyboard(cmd.mode)
        );
        return true;
    }

    if (cmd.type === 'select_agent') {
        const state = loadControlState();
        const agents = loadOhMyAgentKeys();
        await sendKeyboardMessage(
            msg.chat.id,
            `请选择 oh-my-opencode Agent（当前: ${state.selectedAgent || DEFAULT_AGENT}）`,
            buildAgentInlineKeyboard(agents, state.selectedAgent || DEFAULT_AGENT)
        );
        await sendKeyboardMessage(
            msg.chat.id,
            `请选择 superpowers skill profile（当前: ${state.selectedSkillProfile || 'plan'}）`,
            buildSkillInlineKeyboard(state.selectedSkillProfile || 'plan')
        );
        return true;
    }

    if (cmd.type === 'set_skill') {
        setSelectedSkillProfile(cmd.profile);
        await sendInfoMessage(msg.chat.id, `🧠 已设置 skill profile：${prettyProfile(cmd.profile)} (${skillProfileToSkill(cmd.profile)})`);
        return true;
    }

    if (cmd.type === 'set_agent') {
        const agents = loadOhMyAgentKeys();
        if (!agents.includes(cmd.agent)) {
            await sendErrorMessage(msg.chat.id, `未知 Agent: ${cmd.agent}\n可选: ${agents.join(', ')}`);
            return true;
        }
        setSelectedAgent(cmd.agent);
        await sendInfoMessage(msg.chat.id, `🤖 已设置 Agent：${cmd.agent}`);
        return true;
    }

    if (cmd.type === 'start_takeover') {
        const current = loadControlState();
        const profile = current.selectedSkillProfile || inferSkillProfile(cmd.goal);
        startTakeover(cmd.goal, {
            mode: current.mode,
            selectedAgent: current.selectedAgent || DEFAULT_AGENT,
            selectedSkillProfile: profile,
            chatId: String(msg.chat.id),
            activeSessionId: ''
        });
        try {
            const next = await dispatchTakeoverGoal(cmd.goal, 'start');
            await sendInfoMessage(
                msg.chat.id,
                `🚀 接管已开始\nmode=${next.mode}\nagent=${next.selectedAgent}\nskill=${skillProfileToSkill(next.selectedSkillProfile)}`
            );
        } catch (err) {
            markBlocked(`takeover_start_failed: ${err.message}`, { blockedAt: Date.now() });
            await sendErrorMessage(msg.chat.id, `接管启动失败：${err.message}`);
        }
        return true;
    }

    if (cmd.type === 'stop_takeover') {
        const next = stopTakeover({
            chatId: String(msg.chat.id),
            lastProgressAt: Date.now()
        });
        await sendInfoMessage(msg.chat.id, `🛑 已停止接管，当前模式保持为 ${prettyMode(next.mode)} (${next.mode})`);
        return true;
    }

    return false;
}

async function handleQuestionCallback(query) {
    const { data: callbackData, id: queryId, message } = query;
    const parsed = parseQuestionCallback(callbackData);
    console.log(`[PermListener] 📋 parseQuestionCallback 结果:`, JSON.stringify(parsed));
    if (!parsed) {
        await answerCallback(queryId, '无效的回调数据');
        return;
    }

    const pending = getPending(parsed.uniqueId);
    console.log(`[PermListener] 📋 getPending(${parsed.uniqueId}):`, pending ? `type=${pending.type}, sid=${pending.sid}` : 'null');
    // 向后兼容：无 type 字段的条目视为权限条目，不在此处理
    if (!pending || (pending.type && pending.type !== 'question')) {
        await answerCallback(queryId, '问题已过期或已回答');
        return;
    }

    if (parsed.type === 'option') {
        const option = pending.options?.[parsed.optionIndex];
        const answerValue = option?.value || option?.label || `选项 ${parsed.optionIndex + 1}`;
        const answerLabel = option?.label || answerValue;

        try {
            const requestID = await replyQuestion(pending, answerValue);
            updatePending(parsed.uniqueId, { requestID });
            await answerCallback(queryId, `✅ 已选择: ${answerLabel}`);
            await editMessageResult(message.chat.id, message.message_id, message.text || '❓ Agent 提问', `✅ 已选择: ${answerLabel}`);
            removePending(parsed.uniqueId);
            console.log(`[PermListener] ✅ question 已回传 OpenCode: requestID=${requestID} answer=${answerLabel}`);
        } catch (err) {
            await answerCallback(queryId, '回传失败，请稍后重试');
            await sendErrorMessage(message.chat.id, `问题回答回传失败: ${err.message}`);
        }
    } else if (parsed.type === 'custom') {
        let promptMessageId = null;
        try {
            promptMessageId = await sendForceReplyPrompt(
                message.chat.id,
                '✏️ 请输入自定义回答（请直接回复这条消息）：'
            );
        } catch (err) {
            console.warn('[PermListener] force_reply 提示发送失败:', err.message);
        }

        updatePending(parsed.uniqueId, {
            awaitingText: true,
            chatId: message.chat.id,
            messageId: message.message_id,
            customPromptMessageId: promptMessageId,
            expectedUserId: query.from?.id ?? null
        });
        await answerCallback(queryId, '请回复我刚发的输入提示消息');
        await sendInfoMessage(
            message.chat.id,
            '✏️ 请使用“回复（Reply）”方式回复 Permission Bot 的输入提示消息。\n不要 @Napsta6100ks_bot 转发，否则会被当作普通任务。'
        );
    }
}

async function handleTextMessage(msg) {
    // 过滤 1: 只处理目标群组
    if (String(msg.chat.id) !== TELEGRAM_CHANNEL) return;
    // 过滤 2: 忽略 Bot 消息
    if (msg.from && msg.from.is_bot) return;
    // 过滤 3: 必须有文本内容
    if (!msg.text) return;
    // 过滤 4: 忽略命令消息
    const normalized = normalizeGroupAnswerText(msg.text);
    if (!normalized || normalized.startsWith('/')) return;

    console.log(
        `[PermListener] 📨 收到 message: chat=${msg.chat.id}, replyTo=${msg.reply_to_message?.message_id ?? 'none'}, text=${normalized.slice(0, 80)}`
    );

    // 控制指令优先处理（模式切换/接管/选择 Agent）
    if (await handleControlTextCommand(msg, normalized)) return;

    // 先匹配 awaitingText，并优先匹配 reply_to_message（在群隐私模式下更稳定）
    const store = loadStore();
    const now = Date.now();
    let matchedId = null;
    let matchedEntry = null;
    const replyTo = msg.reply_to_message?.message_id ?? null;
    const fromUserId = msg.from?.id ?? null;
    const awaitingEntries = Object.entries(store).filter(([_, entry]) => {
        if (entry.type !== 'question' || !entry.awaitingText) return false;
        if ((now - Number(entry.timestamp || 0)) > QUESTION_TTL_MS) return false;
        if (entry.expectedUserId && fromUserId && Number(entry.expectedUserId) !== Number(fromUserId)) return false;
        return true;
    });

    if (replyTo) {
        for (const [id, entry] of awaitingEntries) {
            if (entry.customPromptMessageId === replyTo || entry.messageId === replyTo) {
                matchedId = id;
                matchedEntry = entry;
                break;
            }
        }
    }

    if (!matchedId || !matchedEntry) {
        // 非 reply 场景只在“唯一等待中问题”时兜底，避免吞掉群内普通消息。
        if (awaitingEntries.length === 1) {
            [matchedId, matchedEntry] = awaitingEntries[0];
            console.log(`[PermListener] ℹ️ 直接文本回答模式: 唯一等待问题 ${matchedId}`);
        }
    }

    if (!matchedId || !matchedEntry) return;

    try {
        const requestID = await replyQuestion(matchedEntry, normalized);
        if (matchedEntry.chatId && matchedEntry.messageId) {
            await editExpiredMessage(matchedEntry.chatId, matchedEntry.messageId);
        }
        removePending(matchedId);
        console.log(`[PermListener] ✅ 自定义回答已回传 OpenCode: requestID=${requestID}`);
        await sendInfoMessage(msg.chat.id, `✅ 已提交自定义回答：${normalized}`);
    } catch (err) {
        console.error('[PermListener] ❌ 自定义回答回传失败:', err.message);
        await sendErrorMessage(msg.chat.id, `自定义回答回传失败: ${err.message}`);
    }
}

// --- Core: handleCallbackQuery ---

async function handleCallbackQuery(query) {
    const { data: callbackData, id: queryId, message } = query;
    console.log(`[PermListener] 📥 收到 callback_query: data=${callbackData}, queryId=${queryId}`);

    // 问题回调路由 — 优先检查
    if (isQuestionCallback(callbackData)) {
        console.log('[PermListener] → 路由到 handleQuestionCallback');
        await handleQuestionCallback(query);
        return;
    }

    // 控制回调路由（模式/agent/skill）
    if (await handleControlCallback(query)) {
        console.log('[PermListener] → 路由到 handleControlCallback');
        return;
    }

    const parsed = parseCallbackData(callbackData);
    console.log(`[PermListener] → 权限回调路由: parsed=`, JSON.stringify(parsed));
    if (!parsed) {
        await answerCallback(queryId, '无效的回调数据');
        return;
    }

    const response = actionToResponse(parsed.action);
    if (!response) {
        await answerCallback(queryId, '未知操作');
        return;
    }

    const pending = getPending(parsed.uniqueId);
    if (!pending) {
        await answerCallback(queryId, '权限请求已过期或已处理');
        return;
    }

    try {
        const apiRes = await fetch(
            `http://localhost:${OPENCODE_PORT}/session/${pending.sid}/permissions/${pending.pid}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ response })
            }
        );

        if (!apiRes.ok) {
            const errText = await apiRes.text().catch(() => '');
            await answerCallback(queryId, `OpenCode 错误: ${apiRes.status}`);
            await sendErrorMessage(message.chat.id, `权限操作失败: ${apiRes.status} ${errText}`);
            return;
        }

        const actionLabel = {
            run: '✅ 已批准（一次）',
            always: '✅ 已批准（始终）',
            reject: '❌ 已拒绝'
        }[parsed.action];

        await answerCallback(queryId, actionLabel);
        await editMessageResult(message.chat.id, message.message_id, message.text, actionLabel);
        removePending(parsed.uniqueId);
    } catch (err) {
        await answerCallback(queryId, `执行失败: ${err.message}`);
    }
}

// --- Main polling loop ---

async function pollUpdates() {
    while (running) {
        try {
            await checkTakeoverStall();
            await autoApproveLowRiskPermissions();

            // 清理过期条目
            const expired = cleanExpired();
            for (const entry of expired) {
                if (entry.type === 'question') {
                    try {
                        await rejectQuestion(entry);
                    } catch (err) {
                        console.warn('[PermListener] question reject 失败 (non-fatal):', err.message);
                    }
                }
                if (entry.chatId && entry.messageId) {
                    await editExpiredMessage(entry.chatId, entry.messageId);
                }
            }

            const res = await fetch(
                `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["callback_query","message"]`
            );
            const data = await res.json();
            if (!data.ok) {
                console.error('[PermListener] getUpdates error:', data.description);
                await sleep(5000);
                continue;
            }

            for (const update of data.result) {
                offset = update.update_id + 1;
                if (update.callback_query) {
                    await handleCallbackQuery(update.callback_query);
                } else if (update.message) {
                    await handleTextMessage(update.message);
                }
            }
        } catch (err) {
            console.error('[PermListener] 轮询错误:', err.message);
            await sleep(5000);
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Graceful shutdown ---
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

// --- Startup ---
async function main() {
    if (!BOT_TOKEN) {
        console.error('[PermListener] ❌ HERMES_PERMISSION_BOT_TOKEN 未设置');
        process.exit(1);
    }

    const me = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const meData = await me.json();
    if (!meData.ok) {
        console.error('[PermListener] ❌ Bot Token 无效:', meData.description);
        process.exit(1);
    }
    console.log(`[PermListener] ✅ 启动成功 — Bot: @${meData.result.username}`);
    console.log(`[PermListener] 📡 开始轮询 callback_query + message...`);

    await pollUpdates();
}

const isMainModule = (() => {
    try {
        return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();

if (isMainModule) {
    main().catch(err => {
        console.error('[PermListener] ❌ 致命错误:', err);
        process.exit(1);
    });
}
