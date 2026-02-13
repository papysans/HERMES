#!/bin/bash
# 检查 ~/.config/opencode/plugins/ 中是否有非预期的插件文件
# 用于防止残留测试插件（如 question-throw-test.js）导致异常行为

PLUGIN_DIR="$HOME/.config/opencode/plugins"
EXPECTED=("hermes-hook.js")
FOUND_UNEXPECTED=0

# 检查目录是否存在
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "ℹ️  插件目录不存在: $PLUGIN_DIR"
  exit 0
fi

# 启用 nullglob，避免无匹配时返回字面量
shopt -s nullglob
JS_FILES=("$PLUGIN_DIR"/*.js)
shopt -u nullglob

if [ ${#JS_FILES[@]} -eq 0 ]; then
  echo "ℹ️  插件目录中无 .js 文件"
  exit 0
fi

for f in "${JS_FILES[@]}"; do
  name=$(basename "$f")
  MATCH=0
  for exp in "${EXPECTED[@]}"; do
    if [ "$name" = "$exp" ]; then
      MATCH=1
      break
    fi
  done
  if [ "$MATCH" -eq 0 ]; then
    echo "⚠️  发现非预期插件: $f"
    FOUND_UNEXPECTED=1
  fi
done

if [ "$FOUND_UNEXPECTED" -eq 0 ]; then
  echo "✅ 插件目录正常，仅包含预期文件"
fi

exit $FOUND_UNEXPECTED
