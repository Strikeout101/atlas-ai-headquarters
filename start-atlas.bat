@echo off
title ATLAS AI Headquarters
cd /d "%~dp0"

rem Starts the ATLAS service (a stable build of the latest commit on port 8800) if it is not running, then opens it.
rem To have it start at every login instead: powershell -ExecutionPolicy Bypass -File scripts\atlas-service\atlas-service.ps1 install
rem For development with live reload use start-atlas-dev.bat (only while the service is stopped).

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Enabling it through Node's corepack...
  call corepack enable
  where pnpm >nul 2>nul || (echo Could not enable pnpm. Install it with: npm install -g pnpm & pause & exit /b 1)
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\atlas-service\atlas-service.ps1" start
if errorlevel 1 (pause & exit /b 1)

echo.
echo ATLAS is starting. The first start builds a release, which takes a few minutes.
echo It opens at http://127.0.0.1:8800 (phones on the home VPN: this PC's LAN address, port 8800).
echo Check on it any time with: powershell -File scripts\atlas-service\atlas-service.ps1 status
echo.
powershell -NoProfile -Command "for ($i=0; $i -lt 300; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8800/api/health | Out-Null; exit 0 } catch { Start-Sleep -Seconds 2 } }; exit 1"
if errorlevel 1 (
  echo ATLAS did not answer yet. See %LOCALAPPDATA%\ATLAS\supervisor.log
  pause
  exit /b 1
)
start "" http://127.0.0.1:8800
