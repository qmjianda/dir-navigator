@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ===============================================================
echo  DirNavigator - automated UI check (headless Chrome/Edge)
echo  Dir: %CD%
echo ===============================================================

where node >nul 2>nul
if errorlevel 1 (echo [x] node not found. Install Node.js 22+ : https://nodejs.org/ & exit /b 1)

node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)"
if errorlevel 1 (echo [x] Node.js 22+ is required: this script uses the built-in WebSocket. & node --version & exit /b 1)

node --version
echo.

node "tools\\ui-check.js" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (echo [OK] UI check passed.) else (echo [x] UI check failed, exit code %CODE%.)
echo.
echo Screenshot: docs\screenshot.png
echo If no Chrome/Edge is found the script prints [SKIP] and exits 0.
echo Set CHROME_PATH to use a specific browser binary.
echo.
if /i not "%~1"=="-nopause" pause
exit /b %CODE%
