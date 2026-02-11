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

import { getPending, removePending, cleanExpired } from './pending-store.js';
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

// --- Core: handleCallbackQuery ---

async function handleCallbackQuery(query) {
    const { data: callbackData, id: queryId, message } = query;

    const parsed = parseCallbackData(callbackData);
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
                `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["callback_query"]`
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
    console.log(`[PermListener] 📡 开始轮询 callback_query...`);

    await pollUpdates();
}

main().catch(err => {
    console.error('[PermListener] ❌ 致命错误:', err);
    process.exit(1);
});
