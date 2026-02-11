#!/bin/bash
#
# Question Tool 注入实验运行器
#
# 用法：
#   ./HERMES/opencode/lib/run-inject-test.sh [mode]
#
# 流程：
#   1. 设置 HERMES_QUESTION_INJECT_MODE
#   2. 复制测试插件到 OpenCode 插件目录
#   3. 提示你重启 OpenCode 并触发 question tool
#   4. 等你确认结果后记录
#
# 示例：
#   ./HERMES/opencode/lib/run-inject-test.sh 0   # 先 dump 结构
#   ./HERMES/opencode/lib/run-inject-test.sh 1   # 测试 answer 字段
#   ./HERMES/opencode/lib/run-inject-test.sh 3   # 测试 answers 字段

MODE=${1:-0}
PLUGIN_DIR="$HOME/.config/opencode/plugins"
PLUGIN_SRC="HERMES/opencode/lib/question-inject-test.js"
PLUGIN_DST="$PLUGIN_DIR/question-inject-test.js"
RESULT_LOG="/tmp/hermes-inject-result.txt"

echo "============================================"
echo "🧪 Question Tool 注入实验 — MODE $MODE"
echo "============================================"
echo ""

# 1. 复制插件
echo "📦 复制测试插件到 $PLUGIN_DST"
mkdir -p "$PLUGIN_DIR"
cp "$PLUGIN_SRC" "$PLUGIN_DST"

# 2. 设置环境变量
echo "🔧 设置 HERMES_QUESTION_INJECT_MODE=$MODE"
echo ""
echo "⚠️  请在启动 OpenCode 的终端中执行："
echo ""
echo "    export HERMES_QUESTION_INJECT_MODE=$MODE"
echo "    opencode --port 4096"
echo ""
echo "然后让 AI 触发 question tool（输入：问我一个选择题）"
echo ""
echo "============================================"
echo "📋 MODE 说明："
echo "  0 — 不注入，只 dump output 结构"
echo "  1 — questions[0].answer = label"
echo "  2 — questions[0].selected = [label]"
echo "  3 — output.args.answers = [[label]]"
echo "  4 — options[0].selected = true"
echo "  5 — questions[0].defaultAnswer = label"
echo "  6 — questions[0].response = label"
echo "  7 — 替换整个 args + answers"
echo "  8 — output.result = 回答文本"
echo "  9 — throw Error"
echo " 10 — output.skip = true"
echo " 11 — return result 对象"
echo "============================================"
echo ""
echo "实验完成后，查看结果："
echo "  cat /tmp/hermes-inject-before-*.json  # 注入前"
echo "  cat /tmp/hermes-inject-after-*.json   # 注入后"
echo "  cat $RESULT_LOG                       # 结果日志"
echo ""
echo "按 Enter 记录本次实验结果..."
read -r

echo ""
echo "本次实验结果？"
echo "  1 — ✅ 成功（跳过了 TUI 对话框）"
echo "  2 — ❌ 失败（TUI 对话框仍然出现）"
echo "  3 — 💥 错误（插件崩溃或 OpenCode 异常）"
echo "  4 — ⏭️ 跳过"
read -r RESULT

case $RESULT in
  1) echo "$(date -Iseconds) | MODE=$MODE | ✅ 成功" >> "$RESULT_LOG" ;;
  2) echo "$(date -Iseconds) | MODE=$MODE | ❌ 失败" >> "$RESULT_LOG" ;;
  3) echo "$(date -Iseconds) | MODE=$MODE | 💥 错误" >> "$RESULT_LOG" ;;
  *) echo "$(date -Iseconds) | MODE=$MODE | ⏭️ 跳过" >> "$RESULT_LOG" ;;
esac

echo ""
echo "✅ 已记录到 $RESULT_LOG"
echo "💡 下一步：运行 ./HERMES/opencode/lib/run-inject-test.sh $((MODE+1))"
