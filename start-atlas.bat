@echo off
title ATLAS AI Headquarters (dev server)
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Enabling it through Node's corepack...
  call corepack enable
  where pnpm >nul 2>nul || (echo Could not enable pnpm. Install it with: npm install -g pnpm & pause & exit /b 1)
)

netstat -ano | findstr /R /C:":8790 .*LISTENING" >nul
if not errorlevel 1 (
  echo Port 8790 is already in use - is the original claw-empire server still running?
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
