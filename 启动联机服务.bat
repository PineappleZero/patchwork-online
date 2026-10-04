@echo off
chcp 65001 >nul
title Patchwork Online
cd /d "%~dp0"

set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"

if not defined NODEEXE (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" (
    set "NODEEXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
  )
)

if not defined NODEEXE (
  echo.
  echo   [ERROR] Node.js not found. Please install Node.js LTS first.
  echo.
  pause
  exit /b 1
)

"%NODEEXE%" server\index.js
if errorlevel 1 (
  echo.
  echo   [Server stopped] See the messages above, or take a screenshot.
  echo.
)
pause
