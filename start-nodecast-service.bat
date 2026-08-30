@echo off
cd /d "C:\Users\CRush\Documents\nodecast-tv"

:loop
"C:\Program Files\nodejs\node.exe" server\index.js >> service.log 2>&1
echo Server exited at %date% %time%, restarting in 5s... >> service.log
timeout /t 5 /nobreak >nul
goto loop
