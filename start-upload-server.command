#!/bin/bash
# 双击运行（macOS）：启动本机 CLI 上传桥接服务。关掉这个终端窗口即停止服务。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js：请先安装 Node.js 18 或更高版本（https://nodejs.org/），再双击本文件。"
  read -r -p "按回车键关闭…" _
  exit 1
fi
PORT="${WRH_UPLOAD_PORT:-17823}"
echo "正在启动小程序上传服务…"
echo "服务地址：http://127.0.0.1:${PORT}/"
echo "首次使用：在浏览器打开这个地址，完成「① 环境设置」并点「一键自检」。"
echo "保持本窗口打开；Chrome 扩展弹窗需要这个服务持续运行。"
echo
exec node upload-server.cjs
