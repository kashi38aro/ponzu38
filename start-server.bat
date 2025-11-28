@echo off
cd /d %~dp0

node -v >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo Error: Node.js is not found.
    echo Please install Node.js and try again.
    echo. 
    pause
    exit /b 1
)

if not exist node_modules (
    echo.
    echo Error: Required npm packages are not installed.
    echo Please run "npm install" in the command prompt and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo Starting OBS Overlay Tool server...
echo.
node server.js

pause