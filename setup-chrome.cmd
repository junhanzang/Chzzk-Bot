@echo off
setlocal
set "DESK_EXTENSION_DIR=%~dp0browser-extension"
set "DESK_CHROME_EXE="

if not exist "%DESK_EXTENSION_DIR%\manifest.json" (
  echo Chrome extension files were not found next to this script.
  if /I not "%~1"=="--print-only" pause
  exit /b 1
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "DESK_CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "DESK_CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "DESK_CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo Chzzk Desk - Chrome setup
echo.
echo Extension folder:
echo "%DESK_EXTENSION_DIR%"
echo.
echo 1. Open chrome://extensions in Chrome.
echo 2. Turn on Developer mode, then choose Load unpacked.
echo 3. Paste the folder path above into the folder picker and confirm.
echo 4. Open the Chzzk Desk extension from the Extensions menu.
echo.
echo For recording, start the desktop app with start-desk.cmd.
echo Copy its connection code and paste it into the extension panel.
echo.

if /I "%~1"=="--print-only" exit /b 0

powershell.exe -NoLogo -NoProfile -Command "try { Set-Clipboard -Value $env:DESK_EXTENSION_DIR -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
  echo Could not copy the path. Copy it from the line above.
) else (
  echo The extension folder path is now on the clipboard.
)

if defined DESK_CHROME_EXE (
  start "" "%DESK_CHROME_EXE%" "chrome://extensions/"
) else (
  echo Chrome was not found in its usual location. Open it yourself.
)
echo.
echo This helper does not install the extension or change Chrome settings.
pause
