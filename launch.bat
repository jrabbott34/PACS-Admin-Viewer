@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies the first time this runs - this can take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Make sure Node.js is installed: https://nodejs.org
        pause
        exit /b 1
    )
)

echo Freeing port 5173 if a previous copy is still running...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)

echo Starting PACS Admin DICOM Viewer...
echo (Leave the new window open while you use the viewer. Close it when you're done.)
start "PACS Admin DICOM Viewer - keep this window open" cmd /k "npm run dev -- --port 5173 --strictPort"

timeout /t 3 /nobreak >nul
start "" "http://localhost:5173/"

endlocal
