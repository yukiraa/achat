@echo off
title achat
cd /d "%~dp0"
rem Stops achat running in the background. You can also press "Stop achat" in the dock.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-old.ps1" -StopOnly
rem step out of the achat folder so this window doesn't keep it in use either
cd /d "%TEMP%"
timeout /t 5 >nul
