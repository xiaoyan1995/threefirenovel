@echo off
chcp 65001 >nul 2>&1
title 焱书 - Agent 服务

echo ========================================
echo   焱书 - Agent 服务（独立启动）
echo ========================================
echo.

:: 设置数据目录
if "%SANHUOAI_DATA_DIR%"=="" (
    set SANHUOAI_DATA_DIR=%APPDATA%\sanhuoai
)
echo 数据目录: %SANHUOAI_DATA_DIR%

:: 创建数据目录
if not exist "%SANHUOAI_DATA_DIR%" mkdir "%SANHUOAI_DATA_DIR%"

echo 启动 Agent 服务 http://127.0.0.1:8765
echo 按 Ctrl+C 停止
echo.

cd /d "%~dp0agent"
python -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload
