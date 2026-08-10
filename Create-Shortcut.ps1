# Create Openhub Desktop Shortcut
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\Openhub.lnk")
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Normal -File `"C:\Users\kency\Desktop\OpenHub\Start-Openhub.ps1`""
$Shortcut.WorkingDirectory = "C:\Users\kency\Desktop\OpenHub"
$Shortcut.Description = "Openhub - AI Agent Control Center"
$Shortcut.IconLocation = "shell32.dll,18"
$Shortcut.Save()

Write-Host "Desktop shortcut created: $DesktopPath\Openhub.lnk" -ForegroundColor Green
