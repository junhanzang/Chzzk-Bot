@echo off
setlocal
title Chzzk Chat Bot
pushd "%~dp0" 2>nul
if errorlevel 1 exit /b 1
set "PYTHONUTF8=1"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" main.py --menu
) else if exist "venv\Scripts\python.exe" (
  "venv\Scripts\python.exe" main.py --menu
) else (
  python main.py --menu
)
set "bot_exit=%errorlevel%"
popd
if not "%bot_exit%"=="0" (
  echo.
  echo Python 3.11 or newer is required. See README.md for installation.
  echo Exit code: %bot_exit%
  pause
)
exit /b %bot_exit%
