@echo off
echo Updating NodeCast TV...
cd /d "%~dp0"
git pull origin main
echo.
echo Done. Restart NodeCast TV the same way you normally do for this to take effect.
pause
