@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
if "%WRH_UPLOAD_PORT%"=="" set WRH_UPLOAD_PORT=17823
echo 正在启动小程序上传服务…
echo 服务地址：http://127.0.0.1:%WRH_UPLOAD_PORT%/
echo 首次使用：在浏览器打开这个地址，完成「① 环境设置」并点「一键自检」。
echo 保持本窗口打开；Chrome 扩展弹窗需要这个服务持续运行。
echo.
node upload-server.cjs
pause
