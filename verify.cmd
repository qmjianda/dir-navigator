@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ===============================================================
echo  DirNavigator - static self-check
echo  Dir: %CD%
echo ===============================================================

where node >nul 2>nul
if errorlevel 1 (echo [x] node not found. Install Node.js LTS: https://nodejs.org/ & echo     To just look at the UI, skip this and open app.html in a browser. & exit /b 1)

node --version
echo.

node "tools\verify.js"
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (echo [OK] static check passed.) else (echo [x] static check failed, exit code %CODE%.)
echo.
echo Note: static check covers structure, syntax and wiring only. Runtime still
echo       needs real testing:
echo        1) open app.html in a browser  -- demo data, checks interaction
echo        2) load plugin.json in uTools dev tools -- real bridge
echo        3) package to .upx and type "folders" -- final form
echo.
if /i not "%~1"=="-nopause" pause
exit /b %CODE%
