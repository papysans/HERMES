#!/bin/bash
# 将 HERMES 源码同步到 OpenCode 运行目录，避免多副本漂移。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${1:-$HOME/.config/opencode}"

SRC_HOOK="$HERMES_ROOT/opencode/hermes-hook.js"
SRC_LIB_DIR="$HERMES_ROOT/opencode/lib"

DST_HOOK="$RUNTIME_ROOT/plugins/hermes-hook.js"
DST_LIB_DIR="$RUNTIME_ROOT/plugins/lib"
DST_WORKSPACE_HOOK="$RUNTIME_ROOT/workspace-hermes/hermes-hook.js"

mkdir -p "$DST_LIB_DIR"

cp "$SRC_HOOK" "$DST_HOOK"
cp "$SRC_LIB_DIR/pending-store.js" "$DST_LIB_DIR/pending-store.js"
cp "$SRC_LIB_DIR/control-state.js" "$DST_LIB_DIR/control-state.js"
cp "$SRC_LIB_DIR/permission-listener.js" "$DST_LIB_DIR/permission-listener.js"
if [ -f "$SRC_LIB_DIR/hermes-hook.test.js" ]; then
  cp "$SRC_LIB_DIR/hermes-hook.test.js" "$DST_LIB_DIR/hermes-hook.test.js"
fi
if [ -f "$SRC_LIB_DIR/permission-listener.test.js" ]; then
  cp "$SRC_LIB_DIR/permission-listener.test.js" "$DST_LIB_DIR/permission-listener.test.js"
fi

if [ -f "$DST_WORKSPACE_HOOK" ]; then
  cp "$SRC_HOOK" "$DST_WORKSPACE_HOOK"
fi

echo "✅ 已同步 HERMES 源码到运行目录: $RUNTIME_ROOT"
