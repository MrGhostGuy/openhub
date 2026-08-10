$ErrorActionPreference='SilentlyContinue'
$node = 'C:\Program Files\nodejs\node.exe'
$BackendDir = 'C:\Users\kency\Desktop\OpenHub'
try {
  $c = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
  if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
} catch {}
Start-Sleep -Seconds 2
$bat = Join-Path $BackendDir '_relaunch_backend.bat'
Set-Content -Path $bat -Value "@echo off`r`ncd /d `"$BackendDir`"`r`nstart `"`" /min `"$node`" server.js > `"$BackendDir\server.out.txt`" 2>`"$BackendDir\server.err.txt`"`r`nexit"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "start `"`" /min `"$bat`"" -WindowStyle Hidden
