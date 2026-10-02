@echo off
setlocal
title Chzzk Desk
if not exist "%~dp0desktop\main.cjs" (
  echo Cannot find desktop\main.cjs next to this launcher.
  echo Keep start-desk.cmd in the project folder.
  pause
  exit /b 1
)
pushd "%~dp0desktop" 2>nul
if errorlevel 1 (
  echo Cannot open the desktop project folder.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: open a terminal and run:
  echo   cd /d "%~dp0desktop"
  echo   npm install
  echo Then run start-desk.cmd again.
  popd
  pause
  exit /b 1
)
rem Launch the installed runtime directly; npm does not need to be on PATH.
rem A terminal may have inherited this flag from another Electron-based tool.
set "ELECTRON_RUN_AS_NODE="
echo Starting Chzzk Desk. If it is already running, its window will be focused.
"node_modules\electron\dist\electron.exe" .
set "desk_exit=%errorlevel%"
popd
if not "%desk_exit%"=="0" (
  echo.
  echo Chzzk Desk could not start or stopped unexpectedly. Exit code: %desk_exit%
  echo Keep this message and the error above when reporting the problem.
  pause
)
exit /b %desk_exit%
