@echo off
setlocal enableextensions
cd /d "%~dp0"

set "NAME=%~1"
if "%NAME%"=="" set "NAME=dir-navigator"

echo ===============================================================
echo  DirNavigator - create GitHub repo and push
echo  Dir : %CD%
echo  Repo: %NAME%
echo ===============================================================
echo.

where git >nul 2>nul || (echo [x] git not found. Install Git for Windows first. & exit /b 1)

if not exist ".git" echo [i] no git repo yet, running init-git.cmd first
if not exist ".git" call "%~dp0init-git.cmd" -nopause

set "HAS_GH=1"
where gh >nul 2>nul || set "HAS_GH=0"
if "%HAS_GH%"=="1" gh auth status >nul 2>nul
if "%HAS_GH%"=="1" if errorlevel 1 set "HAS_GH=0"

if "%HAS_GH%"=="1" echo [i] GitHub CLI ready, creating repo %NAME% ...
if "%HAS_GH%"=="1" gh repo create "%NAME%" --public --description "Visual directory navigator for Windows: bookmark bar plus Miller columns (uTools plugin)" --source=. --remote=origin --push
if "%HAS_GH%"=="1" if errorlevel 1 (echo [x] gh repo create failed. & exit /b 1)
if "%HAS_GH%"=="1" git --no-pager remote -v
if "%HAS_GH%"=="1" (echo. & echo [OK] repo created and pushed. & if /i not "%~2"=="-nopause" pause & exit /b 0)

if "%HAS_GH%"=="0" echo [i] no usable GitHub CLI (install it, then: gh auth login)
echo.
echo Two ways forward:
echo   1^) install GitHub CLI https://cli.github.com/ then run: gh auth login
echo      and run this script again - it will create the repo for you.
echo   2^) open https://github.com/new and create an EMPTY repo named %NAME%
echo      (no README, no .gitignore, no license), then paste its URL below.
echo.
set "URL="
set /p "URL=Repo URL (https://github.com/USER/REPO.git): "
if "%URL%"=="" (echo [x] no URL given. & exit /b 1)

git remote remove origin >nul 2>nul
git remote add origin "%URL%"
git branch -M main
git push -u origin main
if errorlevel 1 (echo [x] push failed - check your PAT / credential manager. & exit /b 1)

echo.
echo [OK] pushed to %URL%
git --no-pager remote -v
echo.
echo Next: open the repo in a browser - CI will run tools/verify.js on GitHub.
if /i not "%~2"=="-nopause" pause
exit /b 0
