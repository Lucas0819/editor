#!/usr/bin/env sh
# 退出码 0 = 本机 3002 端口已有进程在 LISTEN；非 0 = 未监听（可启动 dev）。
# 依赖 lsof（macOS / 常见 Linux 自带）。
if command -v lsof >/dev/null 2>&1; then
  lsof -iTCP:3002 -sTCP:LISTEN -n -P >/dev/null 2>&1
  exit $?
fi
exit 1
