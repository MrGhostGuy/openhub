@echo off
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 2 >nul
start "" /min "C:\Program Files\nodejs\node.exe" "C:\Users\kency\Desktop\OpenHub\server.js"
exit
