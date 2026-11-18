@echo off
title ATLAS AI Headquarters (dev server)
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Enabling it through Node's corepack...
  call corepack enable
  where pnpm >nul 2>nul || (echo Could not enable pnpm. Install it with: npm install -g pnpm & pause & exit /b 1)
)

rem Development mode: every saved server file restarts this server against the REAL database.
rem Day-to-day use start-atlas.bat (the stable service) instead. Both use port 8800, so only one can run.
netstat -ano | findstr /R /C:":8800 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 8800 is in use - the ATLAS service is probably running.
  echo Stop it first: powershell -File scripts\atlas-service\atlas-service.ps1 stop
  pause
  exit /b 1
)
netstat -ano | findstr /R /C:":8790 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 8790 is already in use - is another dev server still running?
  echo Close that window first, then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing packages - first run only, this takes a few minutes...
  call pnpm install || (echo Install failed. & pause & exit /b 1)
)

echo.
echo Starting... the browser opens at http://127.0.0.1:8800 once the server is up.
echo Phones on the home VPN can use this PC's LAN address on port 8800 and the existing password.
echo Keep this window open while you test. Close it (or press Ctrl+C) to stop the server.
echo.
start "" cmd /c "timeout /t 12 >nul & start http://127.0.0.1:8800"
call pnpm dev
pause
