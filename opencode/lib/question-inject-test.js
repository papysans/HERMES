#!/usr/bin/env node
/**
 * Question Tool 注入实验插件
 *
 * 这是一个 OpenCode 插件，用于测试在 tool.execute.before 中
 * 修改 output.args 的不同字段，看哪种方式能让 question tool
 * 跳过 TUI 选择对话框。
 *
 * 用法：
 *   1. 设置环境变量 HERMES_QUESTION_INJECT_MODE 选择注入模式
 *   2. 复制到 ~/.config/opencode/plugins/question-inject-test.js
 *   3. 重启 OpenCode
 *   4. 让 AI 触发 question tool（比如说"问我一个选择题"）
 *   5. 观察 TUI 是否跳过对话框，查看 /tmp/hermes-inject-*.json 日志
 *
 * 注入模式（HERMES_QUESTION_INJECT_MODE）：
 *   0 — 不注入，只 dump（默认，用于确认 output 结构）
 *   1 — output.args.questions[0].answer = "第一个选项的label"
 *   2 — output.args.questions[0].selected = ["第一个选项的label"]
 *   3 — output.args.answers = [["第一个选项的label"]]
 *   4 — output.args.questions[0].options[0].selected = true
 *   5 — output.args.questions[0].defaultAnswer = "第一个选项的label"
 *   6 — output.args.questions[0].response = "第一个选项的label"
 *   7 — 直接替换整个 output.args 为带 answers 的结构
 *   8 — 在 output 上设置 result 字段
 *   9 — throw 一个特殊错误看 question tool 如何处理
 *  10 — 设置 output.skip = true
 *  11 — 返回一个 result 对象
 *
 * 每次实验后查看：
 *   /tmp/hermes-inject-before-*.json  — 注入前的 input/output 快照
 *   /tmp/hermes-inject-after-*.json   — 注入后的 output 快照
 *   /tmp/hermes-inject-result.txt     — 实验结果日志
 */

import { writeFileSync, appendFileSync } from 'node:fs';

const MODE = parseInt(process.env.HERMES_QUESTION_INJECT_MODE || '0', 10);

function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function dump(label, data) {
    const path = `/tmp/hermes-inject-${label}-${ts()}.json`;
    writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`[InjectTest] 📝 ${label} → ${path}`);
}

function logResult(msg) {
    const line = `${new Date().toISOString()} | MODE=${MODE} | ${msg}\n`;
    appendFileSync('/tmp/hermes-inject-result.txt', line);
    console.log(`[InjectTest] ${msg}`);
}

export const QuestionInjectTest = async ({ client }) => {
    logResult(`插件加载，注入模式: ${MODE}`);

    return {
        'tool.execute.before': async (input, output) => {
            if (input.tool !== 'question') return;

            const args = output.args || {};
            const questions = args.questions || [];
            const firstQ = questions[0];
            const firstOption = firstQ?.options?.[0];
            const firstLabel = firstOption?.label || firstOption?.text || 'A';

            // 注入前快照
            dump('before', {
                mode: MODE,
                input: JSON.parse(JSON.stringify(input)),
                output: JSON.parse(JSON.stringify(output)),
                outputKeys: Object.keys(output),
                outputProto: Object.getOwnPropertyNames(Object.getPrototypeOf(output) || {}),
            });

            logResult(`拦截到 question tool, firstLabel="${firstLabel}", mode=${MODE}`);

            switch (MODE) {
                case 0:
                    logResult('MODE 0: 不注入，只 dump output 结构');
                    break;

                case 1:
                    // 猜测: question tool 检查 questions[0].answer
                    logResult(`MODE 1: 设置 questions[0].answer = "${firstLabel}"`);
                    if (firstQ) firstQ.answer = firstLabel;
                    break;

                case 2:
                    // 猜测: 用数组形式的 selected
                    logResult(`MODE 2: 设置 questions[0].selected = ["${firstLabel}"]`);
                    if (firstQ) firstQ.selected = [firstLabel];
                    break;

                case 3:
                    // 匹配 SSE question.replied 的 answers 格式
                    logResult(`MODE 3: 设置 output.args.answers = [["${firstLabel}"]]`);
                    output.args.answers = [[firstLabel]];
                    break;

                case 4:
                    // 标记选项为已选中
                    logResult(`MODE 4: 设置 options[0].selected = true`);
                    if (firstOption) firstOption.selected = true;
                    break;

                case 5:
                    logResult(`MODE 5: 设置 questions[0].defaultAnswer = "${firstLabel}"`);
                    if (firstQ) firstQ.defaultAnswer = firstLabel;
                    break;

                case 6:
                    logResult(`MODE 6: 设置 questions[0].response = "${firstLabel}"`);
                    if (firstQ) firstQ.response = firstLabel;
                    break;

                case 7:
                    // 完全替换 args，加入 answers 字段
                    logResult(`MODE 7: 替换整个 output.args，加入 answers`);
                    output.args = {
                        ...args,
                        answers: [[firstLabel]]
                    };
                    break;

                case 8:
                    // 尝试在 output 上设置 result
                    logResult(`MODE 8: 设置 output.result`);
                    output.result = `User has answered your questions: "${firstQ?.question}"="${firstLabel}"`;
                    break;

                case 9:
                    // 抛出错误看 question tool 如何处理
                    logResult('MODE 9: 抛出错误测试');
                    throw new Error(`[INJECT_TEST] 模拟用户选择: ${firstLabel}`);

                case 10:
                    logResult('MODE 10: 设置 output.skip = true');
                    output.skip = true;
                    output.result = `User answered: ${firstLabel}`;
                    break;

                case 11:
                    // 尝试返回一个值
                    logResult(`MODE 11: 返回 result 对象`);
                    dump('after', { output: JSON.parse(JSON.stringify(output)) });
                    return {
                        result: `User has answered your questions: "${firstQ?.question}"="${firstLabel}"`,
                        answers: [[firstLabel]]
                    };

                default:
                    logResult(`未知 MODE: ${MODE}`);
            }

            // 注入后快照
            dump('after', {
                mode: MODE,
                output: JSON.parse(JSON.stringify(output)),
            });
        }
    };
};
