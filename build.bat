@echo off
chcp 65001 >nul 2>&1
title 三火AI - 构建

echo ========================================
echo   三火AI - 生产构建
echo ========================================
echo.

echo [1/3] 安装依赖...
call npm install
pip install -r agent\requirements.txt
echo.

echo [2/3] 前端构建...
call npm run build
echo.

echo [3/3] Tauri 打包...
npm run tauri build

echo.
echo 构建完成！安装包位于 src-tauri\target\release\bundle\
pause
