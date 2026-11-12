@echo off
title achat
cd /d "%~dp0"

rem One double-click does everything: checks Node.js, installs packages when
rem needed, closes an achat that is still running, then starts achat in the
rem background. This window can be closed afterwards; achat keeps running.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem install on the first run, or when a package is missing after an update
set NEED_INSTALL=0
if not exist node_modules\ws\package.json set NEED_INSTALL=1
if not exist node_modules\tiktok-live-connector\package.json set NEED_INSTALL=1
if "%NEED_INSTALL%"=="1" (
  echo Installing packages, this takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Installing packages failed. Check your internet connection and run start.bat again.
    pause
    exit /b 1
  )
)

rem an achat that is already running would block the port: close it first
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-old.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)

node tools\launch.js
if errorlevel 1 (
  pause
  exit /b 1
)
echo  This window closes by itself in 30 seconds.
rem step out of the achat folder so this window never keeps the folder in use
cd /d "%TEMP%"
timeout /t 30 >nul
