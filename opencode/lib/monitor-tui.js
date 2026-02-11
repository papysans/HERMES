#!/usr/bin/env node
/**
 * TUI Monitor — 监控 OpenCode TUI 的所有信号
 *
 * 同时监听：
 * 1. SSE 事件流 (/event) — 所有 OpenCode 事件
 * 2. TUI control/next 长轮询 — TUI 控制请求
 *
 * 用法: node HERMES/opencode/lib/monitor-tui.js
 *
 * 在 TUI 中操作 question tool 选择对话框时，
 * 这个脚本会记录所有相关信号。
 */

const PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const BASE = `http://localhost:${PORT}`;
const LOG_FILE = '/tmp/hermes-tui-monitor.log';

import { appendFileSync, writeFileSync } from 'node:fs';

function ts() {
    return new Date().toISOString();
}

function log(source, data) {
    const line = `${ts()} [${source}] ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
    console.log(line);
    try { appendFileSync(LOG_FILE, line + '\n'); } catch (_) { }
}

// --- 1. SSE 事件流监听 ---
async function monitorSSE() {
    log('SSE', '开始监听 SSE 事件流...');
    while (true) {
        try {
            const res = await fetch(`${BASE}/event`);
            if (!res.ok) {
                log('SSE', `连接失败: ${res.status}`);
                await sleep(3000);
                continue;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 保留不完整的行

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const event = JSON.parse(data);
                            // 高亮 question 相关事件
                            const isQuestion = event.type?.includes('question') ||
                                event.type?.includes('tool') ||
                                event.type?.includes('control') ||
                                event.type?.includes('dialog') ||
                                event.type?.includes('key') ||
                                event.type?.includes('input');
                            const prefix = isQuestion ? '⭐' : '  ';
                            log('SSE', `${prefix} ${event.type} → ${JSON.stringify(event.properties || {}).slice(0, 500)}`);
                        } catch (_) {
                            if (data.trim()) log('SSE', `RAW: ${data.slice(0, 300)}`);
                        }
                    }
                }
            }
            log('SSE', '连接断开，重连...');
        } catch (err) {
            log('SSE', `错误: ${err.message}`);
        }
        await sleep(3000);
    }
}

// --- 2. TUI control/next 长轮询监听 ---
async function monitorControlNext() {
    log('CTRL', '开始监听 /tui/control/next...');
    while (true) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 35000); // 35s 超时

            const res = await fetch(`${BASE}/tui/control/next`, {
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (res.ok) {
                const body = await res.text();
                log('CTRL', `⭐⭐ /tui/control/next 返回了！ status=${res.status} body=${body}`);
            } else {
                log('CTRL', `/tui/control/next 非 200: ${res.status}`);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                log('CTRL', '超时（35s），重新轮询...');
            } else {
                log('CTRL', `错误: ${err.message}`);
                await sleep(3000);
            }
        }
    }
}

// --- 3. 定期探测 TUI 状态 ---
async function monitorState() {
    log('STATE', '开始定期探测 TUI 状态...');
    while (true) {
        await sleep(2000); // 每 2 秒探测一次
        try {
            // 探测 session 列表
            const sessRes = await fetch(`${BASE}/session`);
            if (sessRes.ok) {
                const sessions = await sessRes.json();
                if (sessions.length > 0) {
                    const s = sessions[0];
                    log('STATE', `session: id=${s.id} status=${s.status || 'unknown'}`);
                }
            }
        } catch (_) { }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- 启动 ---
async function main() {
    writeFileSync(LOG_FILE, `=== TUI Monitor 启动 ${ts()} ===\n`);
    log('MAIN', `监控 OpenCode @ ${BASE}`);
    log('MAIN', `日志文件: ${LOG_FILE}`);
    log('MAIN', '请在 TUI 中触发 question tool 并做选择，所有信号会被记录。');
    log('MAIN', '---');

    // 并行启动所有监控
    await Promise.all([
        monitorSSE(),
        monitorControlNext(),
        monitorState()
    ]);
}

main().catch(err => {
    console.error('致命错误:', err);
    process.exit(1);
});
