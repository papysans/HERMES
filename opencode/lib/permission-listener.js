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

import { getPending, removePending, cleanExpired, updatePending, loadStore, QUESTION_TTL_MS } from './pending-store.js';
// Note: when run from plugins/lib/, this resolves to plugins/lib/pending-store.js (same directory)

const BOT_TOKEN = process.env.HERMES_PERMISSION_BOT_TOKEN;
const OPENCODE_PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const TELEGRAM_CHANNEL = process.env.HERMES_TELEGRAM_CHANNEL || '-5088310983';

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

async function answerCallback(queryId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: queryId, text })
    });
}

async function editMessageResult(chatId, messageId, originalText, result) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `${originalText}\n\n---\n${result}`,
            parse_mode: 'Markdown'
        })
    });
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        })
    });
}

async function editExpiredMessage(chatId, messageId) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            })
        });
    } catch (err) {
        console.warn('[PermListener] 编辑过期消息失败:', err.message);
    }
}

async function sendErrorMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
}

async function sendInfoMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
}

async function sendForceReplyPrompt(chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            reply_markup: {
                force_reply: true,
                selective: false
            }
        })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram force_reply 发送失败: ${data.description}`);
    return data.result?.message_id ?? null;
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
            customPromptMessageId: promptMessageId
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

    // 先匹配 awaitingText，并优先匹配 reply_to_message（在群隐私模式下更稳定）
    const store = loadStore();
    const now = Date.now();
    let matchedId = null;
    let matchedEntry = null;
    const replyTo = msg.reply_to_message?.message_id ?? null;

    if (replyTo) {
        for (const [id, entry] of Object.entries(store)) {
            if (entry.type !== 'question' || !entry.awaitingText) continue;
            if ((now - Number(entry.timestamp || 0)) > QUESTION_TTL_MS) continue;
            if (entry.customPromptMessageId === replyTo || entry.messageId === replyTo) {
                matchedId = id;
                matchedEntry = entry;
                break;
            }
        }
    }

    if (!matchedId || !matchedEntry) {
        for (const [id, entry] of Object.entries(store)) {
            if (entry.type !== 'question' || !entry.awaitingText) continue;
            if ((now - Number(entry.timestamp || 0)) > QUESTION_TTL_MS) continue;
            matchedId = id;
            matchedEntry = entry;
            break;
        }
    }

    if (!matchedId || !matchedEntry) {
        let latestId = null;
        let latestEntry = null;
        for (const [id, entry] of Object.entries(store)) {
            if (entry.type !== 'question') continue;
            if (!entry.awaitingText) continue;
            if ((now - Number(entry.timestamp || 0)) > QUESTION_TTL_MS) continue;
            if (!latestEntry || Number(entry.timestamp || 0) > Number(latestEntry.timestamp || 0)) {
                latestId = id;
                latestEntry = entry;
            }
        }
        if (latestId && latestEntry) {
            matchedId = latestId;
            matchedEntry = latestEntry;
            console.log(`[PermListener] ℹ️ 直接文本回答模式: 使用最近 question ${matchedId}`);
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

main().catch(err => {
    console.error('[PermListener] ❌ 致命错误:', err);
    process.exit(1);
});
