@echo off
setlocal
cd /d "%~dp0.."

echo [Personal Cloud] 配置照片专用 Telegram Bot Secret
echo.
echo 接下来 Wrangler 会要求输入旧照片系统正在使用的 Bot Token。
echo Token 只会写入 Cloudflare Worker Secret，不会写入本地文件或 D1。
echo.
call npx wrangler secret put TELEGRAM_PHOTOS_BOT_TOKEN
if errorlevel 1 (
  echo.
  echo [FAIL] Secret 配置失败，未执行后续验收。
  pause
  exit /b 1
)

echo.
echo [CHECK] 正在执行生产 Photos smoke test...
call npm run photos:smoke:remote
if errorlevel 1 (
  echo.
  echo [FAIL] Secret 已写入，但生产验收未通过。请保留旧照片系统，不要下线。
  pause
  exit /b 2
)

echo.
echo [PASS] 照片专用 Telegram 存储与历史照片兼容链路验收通过。
echo 旧照片 Worker 仍作为只读 legacy bridge 保留，直到执行最终下线阶段。
pause
exit /b 0
