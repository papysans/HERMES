#!/usr/bin/env node
/**
 * Question Tool 回答实验脚本
 *
 * 在 question 对话框打开时运行，尝试不同方式回答。
 *
 * 用法：
 *   node HERMES/opencode/lib/try-answer-question.js [方案] [答案]
 *
 * 方案：
 *   prompt   — append-prompt + submit-prompt（默认）
 *   control  — control/response
 *   both     — 先 prompt 再 control
 *
 * 示例：
 *   node HERMES/opencode/lib/try-answer-question.js prompt "Web App"
 *   node HERMES/opencode/lib/try-answer-question.js control "Web App"
 */

const PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const BASE = `http://localhost:${PORT}`;

const method = process.argv[2] || 'prompt';
const answer = process.argv[3] || 'Web App';

async function post(path, body) {
    const url = `${BASE}${path}`;
    console.log(`  POST ${url}`);
    console.log(`  Body: ${JSON.stringify(body)}`);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    console.log(`  → ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
    return { status: res.status, data: parsed };
}

async function tryPrompt(answer) {
    console.log(`\n🔵 方案 prompt: append-prompt + submit-prompt`);
    console.log(`   答案: "${answer}"`);

    // Step 1: 写入答案到主输入框
    console.log('\n  Step 1: append-prompt');
    const r1 = await post('/tui/append-prompt', { text: answer });

    // Step 2: 提交
    console.log('\n  Step 2: submit-prompt');
    const r2 = await post('/tui/submit-prompt', {});

    console.log(`\n  结果: append=${r1.status}, submit=${r2.status}`);
    return r1.status === 200 && r2.status === 200;
}

async function tryControl(answer) {
    console.log(`\n🟡 方案 control: control/response`);
    console.log(`   答案: "${answer}"`);

    // 尝试不同的 body 格式
    const formats = [
        { body: answer },
        { text: answer },
        { value: answer },
        { response: answer },
        answer  // 纯字符串
    ];

    for (const body of formats) {
        console.log(`\n  尝试格式: ${JSON.stringify(body)}`);
        const r = await post('/tui/control/response', body);
        // 等 1s 看 TUI 是否有反应
        await new Promise(r => setTimeout(r, 1000));
    }
}

async function main() {
    console.log('🧪 Question Tool 回答实验');
    console.log(`   目标: ${BASE}`);
    console.log(`   方案: ${method}`);
    console.log(`   答案: "${answer}"`);

    if (method === 'prompt') {
        await tryPrompt(answer);
    } else if (method === 'control') {
        await tryControl(answer);
    } else if (method === 'both') {
        const ok = await tryPrompt(answer);
        if (!ok) {
            console.log('\n  prompt 失败，尝试 control...');
            await tryControl(answer);
        }
    } else {
        console.log(`❌ 未知方案: ${method}`);
        console.log('   可用: prompt, control, both');
    }

    console.log('\n✅ 实验完成');
    console.log('   请检查 OpenCode TUI — question 对话框是否已关闭？AI 是否继续执行？');
}

main().catch(err => {
    console.error('❌ 致命错误:', err);
    process.exit(1);
});
