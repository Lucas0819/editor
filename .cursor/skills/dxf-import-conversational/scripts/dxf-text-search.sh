#!/usr/bin/env bash
# 按关键词在 DXF 的 TEXT/MTEXT 中检索（stdout 为 JSON）。须先由 dxf-preview 得到图层名，再由 Agent 传入 --keyword 与 --layer。
# 用法：
#   bash .cursor/skills/dxf-import-conversational/scripts/dxf-text-search.sh \
#     --input "/abs/path.dxf" --keyword "一层" --layer "楼层名称"
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
exec bun run "$REPO_ROOT/packages/dxf-import-tool/src/dxf-text-search.ts" "$@"
