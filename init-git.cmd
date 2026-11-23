@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ===============================================================
echo  DirNavigator - git init + first commit
echo  Dir: %CD%
echo ===============================================================

where git >nul 2>nul
if errorlevel 1 (echo [x] git not found. Install Git for Windows: https://git-scm.com/download/win & exit /b 1)

if not exist ".git" git init -q
if exist ".git" echo [i] repository ready: %CD%

git config user.name >nul 2>nul || git config user.name "DirNavigator Dev"
git config user.email >nul 2>nul || git config user.email "dev@dirnavigator.local"

git add -A
if errorlevel 1 (echo [x] git add failed. & exit /b 1)

git diff --cached --quiet
if not errorlevel 1 (echo [i] nothing to commit & echo [OK] done. & exit /b 0)

if exist "tools\commit-msg.txt" (git commit -q -F "tools\commit-msg.txt") else (git commit -q -m "Initial commit: DirNavigator uTools plugin")
if errorlevel 1 (echo [x] git commit failed. & exit /b 1)
echo [i] committed

echo.
echo ---------- last commit ----------
git --no-pager log --oneline --decorate -1
echo.
echo ---------- status ----------
git status --short
echo.
echo ---------- tracked files ----------
git --no-pager ls-files
echo.
echo [OK] done. Next: run verify.cmd
echo.
if /i not "%~1"=="-nopause" pause
exit /b 0
