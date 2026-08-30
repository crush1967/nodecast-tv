@echo off
cd /d "%~dp0"
echo Starting NodeCast TV...
call npm start
if errorlevel 1 (
    echo.
    echo NodeCast TV exited with an error.
    pause
)
