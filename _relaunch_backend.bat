@echo off
cd /d "C:\Users\kency\Desktop\OpenHub"
start "" /min "C:\Program Files\nodejs\node.exe" server.js > "C:\Users\kency\Desktop\OpenHub\server.out.txt" 2>"C:\Users\kency\Desktop\OpenHub\server.err.txt"
exit
