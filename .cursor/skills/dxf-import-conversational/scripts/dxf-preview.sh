#!/usr/bin/env bash
# 从 skill 目录解析仓库根目录，调用 dxf-import-tool 预读（stdout 为 JSON）。
# 用法：在仓库根或任意目录执行均可：
#   bash .cursor/skills/dxf-import-conversational/scripts/dxf-preview.sh --input "/abs/path.dxf" [--sample 10] [--mapping-file m.json]
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts -> dxf-import-conversational -> skills -> .cursor -> repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
exec bun run "$REPO_ROOT/packages/dxf-import-tool/src/dxf-preview.ts" "$@"
