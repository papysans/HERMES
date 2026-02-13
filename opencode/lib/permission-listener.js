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

import { getPending, removePending, cleanExpired, updatePending, loadStore } from './pending-store.js';
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

// --- Question answer helpers ---

/**
 * 将答案发送到 OpenCode（仅限权限相关或未来非 question 用途）。
 *
 * ⚠️ 此函数 **禁止** 从 question 回调处理路径调用。
 *
 * Question 答案的正确路径是：
 *   1. Permission Listener 写入 Pending Store 的 `answer` 字段（updatePending）
 *   2. hermes-hook.js 的 Polling Loop 检测到 answer
 *   3. Polling Loop 通过 throw Error 将答案注入 AI
 *
 * 直接调用此函数发送 question 答案会与 Polling Loop 产生竞争条件，
 * 且 prompt_async 回退路径可能被 Agent 利用来自主回答（参见 P5/P6 问题记录）。
 *
 * @param {string} sessionId - OpenCode session ID
 * @param {string} content - 要发送的内容
 */
async function sendAnswerToOpenCode(sessionId, content) {
    const port = OPENCODE_PORT;

    // 策略 1: 优先使用 TUI control response 端点
    const controlUrl = buildControlResponseUrl(port);
    const controlBody = buildControlResponseBody(content);
    console.log(`[PermListener] 📤 尝试 control/response: content=${String(content).slice(0, 50)}`);

    try {
        const res = await fetch(controlUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(controlBody)
        });
        if (res.ok) {
            console.log(`[PermListener] ✅ control/response 成功`);
            return;
        }
        console.log(`[PermListener] ⚠️ control/response 失败 (${res.status})`);
    } catch (err) {
        console.log(`[PermListener] ⚠️ control/response 异常: ${err.message}`);
    }

    // 策略 2: 回退到 prompt_async
    const fallbackUrl = buildPromptAsyncUrl(port, sessionId);
    const fallbackBody = {
        parts: [{ type: 'text', text: String(content) }]
    };
    console.log(`[PermListener] 📤 回退到 prompt_async: sid=${sessionId}`);

    const fallbackRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody)
    });
    if (!fallbackRes.ok) {
        const errText = await fallbackRes.text().catch(() => '');
        throw new Error(`OpenCode 错误: prompt_async ${fallbackRes.status} ${errText}`);
    }
    console.log(`[PermListener] ✅ prompt_async 回退成功`);
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

        // 写入 answer 字段，由 hermes-hook.js 轮询端读取并 throw Error
        // 不再调用 sendAnswerToOpenCode、editMessage、removePending — 轮询端统一处理
        updatePending(parsed.uniqueId, { answer: answerValue });
        await answerCallback(queryId, `✅ 已选择: ${answerLabel}`);
        console.log(`[PermListener] ✅ 问题回答已写入 pending store: ${answerLabel}`);
    } else if (parsed.type === 'custom') {
        updatePending(parsed.uniqueId, {
            awaitingText: true,
            chatId: message.chat.id,
            messageId: message.message_id
        });
        await answerCallback(queryId, '请直接在群组中输入你的回答');
    }
}

async function handleTextMessage(msg) {
    // 过滤 1: 只处理目标群组
    if (String(msg.chat.id) !== TELEGRAM_CHANNEL) return;
    // 过滤 2: 忽略 Bot 消息
    if (msg.from && msg.from.is_bot) return;
    // 过滤 3: 必须有文本内容
    if (!msg.text) return;

    // 过滤 4: 只在有等待文本输入的问题条目时才处理
    const store = loadStore();
    let matchedId = null;
    let matchedEntry = null;
    for (const [id, entry] of Object.entries(store)) {
        if (entry.type === 'question' && entry.awaitingText) {
            matchedId = id;
            matchedEntry = entry;
            break;
        }
    }

    if (!matchedId || !matchedEntry) return;

    // 写入 answer 字段，由 hermes-hook.js 轮询端读取并 throw Error
    // 不再调用 sendAnswerToOpenCode、editMessage、removePending — 轮询端统一处理
    updatePending(matchedId, { answer: msg.text, awaitingText: false });
    console.log(`[PermListener] ✅ 自定义回答已写入 pending store: ${msg.text.slice(0, 50)}`);
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
