#!/bin/bash
# 检查 ~/.config/opencode/plugins/ 中是否有非预期的插件文件
# 用于防止残留测试插件（如 question-throw-test.js）导致异常行为

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGIN_DIR="$HOME/.config/opencode/plugins"
EXPECTED=("hermes-hook.js" "superpowers.js")
FOUND_UNEXPECTED=0
FOUND_MISMATCH=0

CANON_HOOK="$HERMES_ROOT/opencode/hermes-hook.js"
CANON_LIB_DIR="$HERMES_ROOT/opencode/lib"
RUNTIME_HOOK="$PLUGIN_DIR/hermes-hook.js"
RUNTIME_LIB_DIR="$PLUGIN_DIR/lib"
WORKSPACE_HOOK="$HOME/.config/opencode/workspace-hermes/hermes-hook.js"

hash_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

check_hash_equal() {
  local src="$1"
  local dst="$2"
  local label="$3"
  if [ ! -f "$src" ] || [ ! -f "$dst" ]; then
    echo "⚠️  $label 缺失: src=$src dst=$dst"
    FOUND_MISMATCH=1
    return
  fi
  local src_hash dst_hash
  src_hash="$(hash_file "$src")"
  dst_hash="$(hash_file "$dst")"
  if [ "$src_hash" != "$dst_hash" ]; then
    echo "⚠️  $label 不一致:"
    echo "    src: $src"
    echo "    dst: $dst"
    FOUND_MISMATCH=1
  fi
}

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

check_hash_equal "$CANON_HOOK" "$RUNTIME_HOOK" "hermes-hook.js"
for f in control-state.js pending-store.js permission-listener.js; do
  check_hash_equal "$CANON_LIB_DIR/$f" "$RUNTIME_LIB_DIR/$f" "lib/$f"
done

if [ -f "$WORKSPACE_HOOK" ]; then
  check_hash_equal "$CANON_HOOK" "$WORKSPACE_HOOK" "workspace-hermes/hermes-hook.js"
fi

if [ "$FOUND_UNEXPECTED" -eq 0 ] && [ "$FOUND_MISMATCH" -eq 0 ]; then
  echo "✅ 运行目录与 HERMES 源码一致"
fi

if [ "$FOUND_UNEXPECTED" -ne 0 ] || [ "$FOUND_MISMATCH" -ne 0 ]; then
  exit 1
fi

exit 0
