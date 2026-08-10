Set oWS = WScript.CreateObject("WScript.Shell")
sLinkFile = "C:\Users\kency\Desktop\Openhub.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = "powershell.exe"
oLink.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\kency\Desktop\OpenHub\Start-Openhub.ps1"""
oLink.WorkingDirectory = "C:\Users\kency\Desktop\OpenHub"
oLink.Description = "Openhub - AI Agent Control Center"
oLink.WindowStyle = 7
oLink.IconLocation = "C:\Users\kency\Desktop\OpenHub\jorm_avatar.ico, 0"
oLink.Save
