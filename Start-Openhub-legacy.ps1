# Openhub Launcher v2 - One-click startup
# Starts: OpenClaw Gateway, Claw3D, Openhub Dashboard

$ErrorActionPreference = "SilentlyContinue"
$OPENHUB_DIR = "C:\Users\kency\Desktop\OpenHub"
$CLAW3D_DIR = "C:\Users\kency\claw3d"

function Write-Status($msg, $color = "White") {
    Write-Host "  $msg" -ForegroundColor $color
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Openhub Launcher - AI Control Center" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# === Step 1: OpenClaw Gateway ===
Write-Host "[1/3] OpenClaw Gateway" -ForegroundColor Yellow

# Check if gateway is already running
$gwRunning = $false
try {
    $test = Invoke-WebRequest -Uri "http://127.0.0.1:18789/health" -TimeoutSec 2 -ErrorAction Stop
    $gwRunning = $true
    Write-Status "Already running" -color Green
} catch {
    Write-Status "Starting gateway..." -color Yellow
    Start-Process powershell -ArgumentList "-WindowStyle Minimized -Command `"openclaw gateway start`"" -WindowStyle Hidden
    Start-Sleep -Seconds 6
    try {
        $test = Invoke-WebRequest -Uri "http://127.0.0.1:18789/health" -TimeoutSec 3 -ErrorAction Stop
        Write-Status "Gateway: ONLINE" -color Green
    } catch {
        Write-Status "Gateway: Starting (may take a moment)" -color Yellow
    }
}

# === Step 2: Claw3D ===
Write-Host "[2/3] Claw3D Virtual Office" -ForegroundColor Yellow

# Check if Claw3D is already running on 3002
$c3dRunning = $false
try {
    $test = Invoke-WebRequest -Uri "http://127.0.0.1:3002" -TimeoutSec 2 -ErrorAction Stop
    $c3dRunning = $true
    Write-Status "Already running on port 3002" -color Green
} catch {
    Write-Status "Starting Claw3D on port 3002..." -color Yellow
    Start-Process powershell -ArgumentList "-WindowStyle Minimized -Command `"cd '$CLAW3D_DIR'; node server/index.js --dev`"" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    try {
        $test = Invoke-WebRequest -Uri "http://127.0.0.1:3002" -TimeoutSec 3 -ErrorAction Stop
        Write-Status "Claw3D: ONLINE" -color Green
    } catch {
        Write-Status "Claw3D: Starting (takes ~10s first time)" -color Yellow
    }
}

# === Step 3: Openhub Dashboard ===
Write-Host "[3/3] Openhub Dashboard" -ForegroundColor Yellow

# Check if Openhub is already running on 3000
$openhubRunning = $false
try {
    $test = Invoke-WebRequest -Uri "http://127.0.0.1:3000" -TimeoutSec 2 -ErrorAction Stop
    $openhubRunning = $true
    Write-Status "Already running on port 3000" -color Green
} catch {
    Write-Status "Starting Openhub on port 3000..." -color Yellow
    Start-Process powershell -ArgumentList "-WindowStyle Hidden -Command `"cd '$OPENHUB_DIR'; node server.js`"" -WindowStyle Hidden
    Start-Sleep -Seconds 4
    try {
        $test = Invoke-WebRequest -Uri "http://127.0.0.1:3000" -TimeoutSec 3 -ErrorAction Stop
        Write-Status "Openhub: ONLINE" -color Green
    } catch {
        Write-Status "Openhub: Starting..." -color Yellow
    }
}

# === Open Browser ===
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Opening Openhub in browser..." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Start-Sleep -Seconds 2
Start-Process "http://127.0.0.1:3000"
