#!/usr/bin/env node
/**
 * Question Tool 事件监控器
 *
 * 监听 SSE 事件流，只显示 question 相关事件。
 * 用于配合 question-inject-test.js 实验，实时观察注入是否生效。
 *
 * 用法：
 *   node HERMES/opencode/lib/watch-question.js
 *
 * 关注的事件：
 *   - question.asked    → question tool 开始，显示问题和选项
 *   - question.replied   → 用户回答了（或被注入了答案）
 *   - message.part.updated (tool=question) → tool 状态变化
 *
 * 判断注入是否成功：
 *   ✅ 成功 = question.asked 后立即出现 question.replied（无需手动选择）
 *   ❌ 失败 = question.asked 后 TUI 显示选择对话框，需要手动操作
 */

const PORT = process.env.HERMES_OPENCODE_PORT || '4096';
const BASE = `http://localhost:${PORT}`;

let questionAskedTime = null;

function formatTime() {
    return new Date().toISOString().slice(11, 23);
}

async function main() {
    console.log('👁️  Question Tool 事件监控器');
    console.log(`   目标: ${BASE}/event`);
    console.log(`   时间: ${new Date().toISOString()}`);
    console.log('   等待 question 事件...');
    console.log('─'.repeat(60));

    const res = await fetch(`${BASE}/event`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
                const event = JSON.parse(jsonStr);
                handleEvent(event);
            } catch { }
        }
    }
}

function handleEvent(event) {
    const t = formatTime();

    if (event.type === 'question.asked') {
        questionAskedTime = Date.now();
        const props = event.properties || {};
        const q = props.questions?.[0];
        console.log(`\n${t} ⭐ question.asked`);
        console.log(`   ID: ${props.id}`);
        console.log(`   问题: ${q?.question}`);
        console.log(`   选项: ${(q?.options || []).map(o => o.label).join(' | ')}`);
        console.log(`   callID: ${props.tool?.callID}`);
        console.log('   ⏳ 等待 question.replied...');
        return;
    }

    if (event.type === 'question.replied') {
        const elapsed = questionAskedTime ? Date.now() - questionAskedTime : '?';
        const props = event.properties || {};
        console.log(`\n${t} ⭐ question.replied (${elapsed}ms)`);
        console.log(`   requestID: ${props.requestID}`);
        console.log(`   answers: ${JSON.stringify(props.answers)}`);
        if (typeof elapsed === 'number' && elapsed < 2000) {
            console.log(`   🎉 注入可能成功！（${elapsed}ms < 2s，无需手动选择）`);
        } else {
            console.log(`   ⚠️  耗时 ${elapsed}ms — 可能是手动选择的`);
        }
        questionAskedTime = null;
        return;
    }

    // tool 状态变化
    if (event.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (part?.tool === 'question') {
            const status = part.state?.status;
            console.log(`${t}    tool.question → ${status}`);
            if (status === 'completed') {
                const output = part.state?.output || '';
                console.log(`   output: ${output.slice(0, 200)}`);
            }
        }
    }
}

main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
});
