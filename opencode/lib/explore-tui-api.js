#!/usr/bin/env node
/**
 * OpenCode TUI API 探测脚本 v2
 *
 * 用法：
 *   1. 先启动 OpenCode: opencode --port 4096
 *   2. 在 OpenCode 中触发一个 question tool（让 AI 问你一个问题）
 *   3. 当 TUI 显示选择对话框时，运行此脚本
 *
 *   node HERMES/opencode/lib/explore-tui-api.js
 */

const PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const BASE = `http://localhost:${PORT}`;

async function probe(label, method, path, body, timeoutMs = 5000) {
    const url = `${BASE}${path}`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 ${label}`);
    console.log(`   ${method} ${url}`);
    if (body) console.log(`   Body: ${JSON.stringify(body)}`);
    console.log('-'.repeat(60));

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        clearTimeout(timer);
        const text = await res.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        console.log(`   Status: ${res.status} ${res.statusText}`);
        console.log(`   Response: ${JSON.stringify(parsed, null, 2).slice(0, 500)}`);
        return { status: res.status, data: parsed };
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log(`   ⏰ 超时 (${timeoutMs}ms) — 端点在长轮询或不存在`);
            return { status: -1, error: 'timeout' };
        }
        console.log(`   ❌ Error: ${err.message}`);
        return { status: -1, error: err.message };
    }
}

async function main() {
    console.log('🚀 OpenCode TUI API 探测脚本 v2');
    console.log(`   目标: ${BASE}`);
    console.log(`   时间: ${new Date().toISOString()}`);

    // 1. 基础连通性
    await probe('列出 sessions', 'GET', '/session');

    // 2. control/next — 3s 超时（长轮询）
    await probe('TUI control/next (3s 超时)', 'GET', '/tui/control/next', null, 3000);

    // 3. control/response 各种格式
    await probe('control/response (body: "test")', 'POST', '/tui/control/response', { body: 'test' });
    await probe('control/response (value: "test")', 'POST', '/tui/control/response', { value: 'test' });
    await probe('control/response (index: 0)', 'POST', '/tui/control/response', { index: 0 });
    await probe('control/response (answer: "test")', 'POST', '/tui/control/response', { answer: 'test' });

    // 4. TUI prompt 端点
    await probe('append-prompt', 'POST', '/tui/append-prompt', { body: 'test' });
    await probe('submit-prompt', 'POST', '/tui/submit-prompt', {});

    // 5. 可能的 TUI 交互端点
    await probe('TUI /tui/state', 'GET', '/tui/state', null, 3000);
    await probe('TUI /tui/input (enter)', 'POST', '/tui/input', { key: 'enter' });
    await probe('TUI /tui/input (down)', 'POST', '/tui/input', { key: 'down' });
    await probe('TUI /tui/key (enter)', 'POST', '/tui/key', { key: 'enter' });
    await probe('TUI /tui/key (down)', 'POST', '/tui/key', { key: 'down' });

    // 6. 探测 question 相关端点
    await probe('GET /tui/question', 'GET', '/tui/question', null, 3000);
    await probe('POST /tui/question/answer', 'POST', '/tui/question/answer', { answer: 'test' });
    await probe('POST /tui/question/select', 'POST', '/tui/question/select', { index: 0 });

    // 7. 探测 dialog 相关端点
    await probe('GET /tui/dialog', 'GET', '/tui/dialog', null, 3000);
    await probe('POST /tui/dialog/select', 'POST', '/tui/dialog/select', { index: 0 });
    await probe('POST /tui/dialog/submit', 'POST', '/tui/dialog/submit', { value: 'test' });

    // 8. 列出所有可用路由（如果有这样的端点）
    await probe('GET / (根路径)', 'GET', '/', null, 3000);
    await probe('GET /api', 'GET', '/api', null, 3000);
    await probe('GET /routes', 'GET', '/routes', null, 3000);

    // 9. SSE 事件流采样 3s
    console.log(`\n${'='.repeat(60)}`);
    console.log('🔍 SSE 事件流 (GET /event, 3s 采样)');
    console.log('-'.repeat(60));
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${BASE}/event`, { signal: controller.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 2000) break;
            }
        } catch (e) {
            if (e.name !== 'AbortError') throw e;
        }
        console.log(`   收到 ${buffer.length} 字节:`);
        console.log(buffer.slice(0, 1500));
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.log(`   ❌ Error: ${err.message}`);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ 探测完成');
    console.log('\n💡 关键发现:');
    console.log('   - control/next 超时 = question tool 不使用 control request 机制');
    console.log('   - 查看哪些端点返回 200 vs 404 来确定可用 API');
    console.log('   - 查看 /tmp/hermes-question-*.json 获取 output.args 结构');
    console.log('   - 查看 /tmp/hermes-events.log 获取事件日志');
}

main().catch(err => {
    console.error('❌ 致命错误:', err);
    process.exit(1);
});
