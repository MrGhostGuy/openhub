@echo off
title Openhub - AI Agent Control Center
color 0B

echo.
echo ========================================
echo   Openhub - AI Agent Control Center
echo ========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    echo.
)

:: Check if .env file exists
if not exist ".env" (
    echo [INFO] Creating .env file with defaults...
    (
        echo # Openhub Configuration
        echo PORT=3000
        echo # Add your OpenRouter API key below for AI chat (optional - free models work without it)
        echo # OPENROUTER_API_KEY=your_key_here
        echo # Add Twitch credentials below (optional)
        echo # TWITCH_CLIENT_ID=your_client_id
        echo # TWITCH_CLIENT_SECRET=your_client_secret
        echo # TWITCH_USERNAME=GhostLegacyX
    ) > .env
    echo [INFO] .env file created. Edit it to add API keys.
    echo.
)

:: Start Openhub server
echo [1/1] Starting Openhub server...
echo.
echo ========================================
echo   Openhub is running!
echo   Dashboard: http://localhost:3000
echo   WebSocket: ws://localhost:3000
echo   Claw3D: http://localhost:3002
echo ========================================
echo.
echo Press Ctrl+C to stop the server
echo.

node server.js

pause
