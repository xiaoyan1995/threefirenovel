@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title SanhuoAI - Dev Mode
cd /d "%~dp0"

echo ========================================
echo   SanhuoAI - Dev Startup
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node.js first.
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm not found. Reinstall Node.js.
    pause
    exit /b 1
)

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Install Python 3.10+ first.
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq sanhuoai.exe" | find /I "sanhuoai.exe" >nul
if %errorlevel% equ 0 (
    echo [WARN] Found running sanhuoai.exe, closing stale app instances...
    taskkill /IM sanhuoai.exe /F >nul 2>&1
    timeout /t 1 >nul
)

set "VITE_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":1420 .*LISTENING"') do (
    set "VITE_PID=%%P"
)
if defined VITE_PID (
    echo [WARN] Port 1420 is already in use.
    echo Occupied by:
    tasklist /FI "PID eq !VITE_PID!" /FO TABLE | findstr /V "INFO:"
    echo Attempting to stop stale process...
    taskkill /PID !VITE_PID! /F >nul 2>&1
    timeout /t 1 >nul
    set "VITE_PID="
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":1420 .*LISTENING"') do (
        set "VITE_PID=%%P"
    )
    if defined VITE_PID (
        echo [ERROR] Port 1420 is still occupied by PID !VITE_PID!.
        echo Please close it manually and retry:
        echo taskkill /PID !VITE_PID! /F
        pause
        exit /b 1
    )
    echo [OK] Cleared port 1420.
)

set "AGENT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8765 .*LISTENING"') do (
    set "AGENT_PID=%%P"
)
if defined AGENT_PID (
    echo [WARN] Port 8765 is already in use.
    echo Occupied by:
    tasklist /FI "PID eq !AGENT_PID!" /FO TABLE | findstr /V "INFO:"
    echo Attempting to stop stale process...
    taskkill /PID !AGENT_PID! /F >nul 2>&1
    timeout /t 1 >nul
    set "AGENT_PID="
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8765 .*LISTENING"') do (
        set "AGENT_PID=%%P"
    )
    if defined AGENT_PID (
        echo [ERROR] Port 8765 is still occupied by PID !AGENT_PID!.
        echo Please close it manually and retry:
        echo taskkill /PID !AGENT_PID! /F
        pause
        exit /b 1
    )
    echo [OK] Cleared port 8765.
)

if not exist "node_modules" (
    echo [1/2] Installing frontend dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

python -c "import importlib.util,sys;mods=['fastapi','multipart','pypdf'];sys.exit(0 if all(importlib.util.find_spec(m) for m in mods) else 1)" >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/2] Installing Python dependencies...
    python -m pip install -r agent\requirements.txt
    if %errorlevel% neq 0 (
        echo [ERROR] Python dependency install failed.
        pause
        exit /b 1
    )
    echo.
)

echo [START] Tauri Dev Mode

echo Frontend: http://127.0.0.1:1420

echo Agent:    http://127.0.0.1:8765

echo Press Ctrl+C to stop

echo.

npm run tauri dev
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Startup failed. Check logs above.
    echo Common causes: occupied ports / Rust toolchain issue / broken dependencies.
    pause
    exit /b 1
)
