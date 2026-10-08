@echo off
rem Double-click to start the Site Visit Tracker dashboard. Close this window to stop it.
title Site Visit Tracker
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install --no-fund --no-audit || goto :failed
)
rem Open the dashboard once the server has had a moment to start.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:4000"
call npm start
echo.
echo The tracker has stopped.
pause
exit /b

:failed
echo.
echo Could not install dependencies. Check that Node.js 22.13 or newer is installed.
pause
