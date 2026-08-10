# Openhub Complete Launcher
# Starts: Claw3D, Openhub Dashboard, Opens Browser

$ErrorActionPreference = "SilentlyContinue"
$OPENHUB_DIR = "C:\Users\kency\Desktop\OpenHub"
$CLAW3D_DIR = "C:\Users\kency\claw3d"

function Write-Status($msg, $color = "White") {
    Write-Host "  $msg" -ForegroundColor $color
}

function Test-Port($port) {
    try {
        $test = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -TimeoutSec 2 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

Clear-Host
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OPENHUB - AI Agent Control Center" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# === Step 1: Claw3D Virtual Office ===
Write-Host "[1/3] Claw3D Virtual Office" -ForegroundColor Yellow

if (Test-Port 3002) {
    Write-Status "Already running on port 3002" -color Green
} else {
    Write-Status "Starting Claw3D on port 3002..." -color Yellow
    Start-Process powershell -ArgumentList "-WindowStyle Minimized -Command `"cd '$CLAW3D_DIR'; node server/index.js`"" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    if (Test-Port 3002) {
        Write-Status "Claw3D: ONLINE" -color Green
    } else {
        Write-Status "Claw3D: Starting (may take ~10s first time)" -color Yellow
    }
}

# === Step 2: Openhub Dashboard ===
Write-Host "[2/3] Openhub Dashboard" -ForegroundColor Yellow

if (Test-Port 3000) {
    Write-Status "Already running on port 3000" -color Green
} else {
    Write-Status "Starting Openhub on port 3000..." -color Yellow
    Start-Process powershell -ArgumentList "-WindowStyle Hidden -Command `"cd '$OPENHUB_DIR'; node server.js`"" -WindowStyle Hidden
    Start-Sleep -Seconds 4
    if (Test-Port 3000) {
        Write-Status "Openhub: ONLINE" -color Green
    } else {
        Write-Status "Openhub: Starting..." -color Yellow
    }
}

# === Step 3: Open Browser ===
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  All services started!" -ForegroundColor Green
Write-Host "  Dashboard: http://127.0.0.1:3000" -ForegroundColor Green
Write-Host "  Claw3D: http://127.0.0.1:3002" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Opening browser..." -ForegroundColor Cyan
Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:3000"
Write-Host ""
Write-Host "  Press any key to exit launcher (services keep running)..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
