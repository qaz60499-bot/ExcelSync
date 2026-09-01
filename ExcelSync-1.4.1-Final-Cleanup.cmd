@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
set "CURRENT=1.4.1"
set "NEWEXE=%ROOT%dist\win-unpacked\ExcelSync.exe"
set "SELF=%~f0"

echo [ExcelSync 1.4.1] 最终旧版本收尾清理
echo.

if not exist "%NEWEXE%" (
  echo [停止] 找不到当前 1.4.1 主程序：
  echo %NEWEXE%
  pause
  exit /b 2
)

for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "(Get-Item -LiteralPath '%NEWEXE%').VersionInfo.FileVersion"`) do set "FILEVER=%%V"
echo 当前主程序版本：%FILEVER%
echo.
echo %FILEVER% | findstr /b /c:"1.4.1" >nul
if errorlevel 1 (
  echo [停止] 当前主程序不是 1.4.1，拒绝清理。
  pause
  exit /b 3
)

echo [1/4] 删除旧源码基线和临时目录...
for %%D in (
  ".baseline-1.2.4"
  "Tempexcel-sync-130-fresh"
  ".wrangler-photo-fresh"
) do (
  if exist "%ROOT%%%~D" (
    echo   删除目录：%%~D
    rmdir /s /q "%ROOT%%%~D"
  )
)

echo [2/4] 删除已废弃的 1.3.0 / 1.3.1 升级与运行冒烟脚本...
for %%F in (
  "scripts\desktop-upgrade-1.3.0.cjs"
  "scripts\desktop-upgrade-1.3.1.cjs"
  "scripts\run-desktop-cleanup-1.3.0.cjs"
  "scripts\run-desktop-cleanup-1.3.1.cjs"
  "scripts\runtime-production-1.3.1-smoke.cjs"
  "scripts\runtime-production-ui-smoke-1.3.1.cjs"
) do (
  if exist "%ROOT%%%~F" (
    echo   删除文件：%%~F
    del /f /q "%ROOT%%%~F"
  )
)

echo [3/4] 清理 dist 中所有非 1.4.1 的版本化安装产物...
powershell.exe -NoProfile -Command "$root = '%ROOT%'; $keep = '1.4.1'; $dist = Join-Path $root 'dist'; if (Test-Path -LiteralPath $dist) { Get-ChildItem -LiteralPath $dist -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^ExcelSync-(Setup|Portable)-[0-9]+\.[0-9]+\.[0-9]+-x64\.exe(\.blockmap)?$' -and $_.Name -notmatch ([regex]::Escape($keep)) } | ForEach-Object { Write-Host ('  删除旧分发产物：' + $_.Name); Remove-Item -LiteralPath $_.FullName -Force } }"

echo [4/4] 清理旧桌面一次性文件和异常 nul 残留...
powershell.exe -NoProfile -Command "$desktop = [Environment]::GetFolderPath('Desktop'); Get-ChildItem -LiteralPath $desktop -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'ExcelSync-*-一次性清理旧版.cmd' -or $_.Name -eq 'ExcelSync-Cleanup-Old-Versions.cmd' } | Remove-Item -Force -ErrorAction SilentlyContinue"
powershell.exe -NoProfile -Command "$p = '\\?\' + (Join-Path '%ROOT%' 'nul'); try { if ([System.IO.File]::Exists($p)) { [System.IO.File]::Delete($p) } } catch {}"

echo.
echo 已保留：
echo   - ExcelSync 1.4.1 当前源码和 dist\win-unpacked
echo   - ExcelSync-Setup-1.4.1-x64.exe
echo   - ExcelSync-Portable-1.4.1-x64.exe
echo   - tests\enterprise-acl-1.3.1.test.ts（兼容性回归测试）
echo   - %%APPDATA%%\ExcelSync 用户配置、Session、本地 SQLite 和缓存
echo   - 实际同步目录、用户文件、migrations 和当前测试
echo.
echo 最终旧版本清理完成。
echo 本文件将在窗口关闭后自动删除。
pause
start "" cmd /c "timeout /t 2 /nobreak >nul & del /f /q \"%SELF%\""
exit /b 0
