# ─────────────────────────────────────────────────────────────────────────────
# Ix — Windows Installer (PowerShell)
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ── Config ───────────────────────────────────────────────────────────────────

$GithubOrg = "ix-infrastructure"
$GithubRepo = "Ix"
$GithubRaw = "https://raw.githubusercontent.com/$GithubOrg/$GithubRepo/main"
$IxHome = if ($env:IX_HOME) { $env:IX_HOME } else { "$env:USERPROFILE\.ix" }
$IxBin = "$IxHome\bin"
$ComposeDir = "$IxHome\backend"
$HealthUrl = "http://localhost:8090/v1/health"
$ArangoUrl = "http://localhost:8529/_api/version"
$NodeMinMajor = 20

# ── Helpers ──────────────────────────────────────────────────────────────────

function Pause-On-Failure {
    if ($Host.Name -eq "ConsoleHost") {
        Write-Host ""
        Read-Host "Press Enter to exit"
    }
}

function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) {
    Write-Host "  [error] $msg" -ForegroundColor Red
    Pause-On-Failure
    exit 1
}

trap {
    Write-Host ""
    Write-Host "Ix installer failed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Error:"
    Write-Host "  $($_.Exception.Message)"
    Write-Host ""
    Pause-On-Failure
    exit 1
}

function Test-Healthy {
    try {
        $null = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -ErrorAction Stop
        $null = Invoke-WebRequest -Uri $ArangoUrl -TimeoutSec 3 -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Get-LatestVersion {
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$GithubOrg/$GithubRepo/releases/latest"
        return $release.tag_name -replace '^v',''
    } catch { return "0.6.0" }
}

function Test-DockerRunning {
    $output = cmd /c "docker info 2>&1"
    if ($LASTEXITCODE -eq 0) { return $true }

    Write-Host "Docker not reachable:"
    $output | ForEach-Object { Write-Host "  $_" }
    return $false
}

# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`nIx Installer`n"

$Version = Get-LatestVersion
Write-Host "Version: $Version"

# ── Node ──
Write-Host "`n-- Node.js --"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Ok "Node $(& node -v)"
} else {
    Write-Err "Node not installed"
}

# ── Docker ──
Write-Host "`n-- Docker --"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker not installed"
}

Write-Ok "Docker installed"

if (-not (Test-DockerRunning)) {
    Write-Err "Docker not running"
}

Write-Ok "Docker running"

# ── Backend ──
Write-Host "`n-- Backend --"

if (Test-Healthy) {
    Write-Ok "Backend already running"
} else {
    New-Item -ItemType Directory -Force -Path $ComposeDir | Out-Null

    $composeFile = "$ComposeDir\docker-compose.yml"

    Write-Host "Downloading compose..."
    curl.exe -L -o "$composeFile" "$GithubRaw/docker-compose.standalone.yml"
    Write-Ok "Compose ready"

    Write-Host "Starting backend..."
    docker compose -f "$composeFile" up -d --pull always

    if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker compose failed"
    }

    Write-Ok "Backend started"
}

# ── CLI ──
Write-Host "`n-- CLI --"

$Tarball = "ix-$Version-windows-amd64.zip"
$Url = "https://github.com/$GithubOrg/$GithubRepo/releases/download/v$Version/$Tarball"
$tmp = "$env:TEMP\$Tarball"
$InstallDir = "$IxHome\cli"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $IxBin | Out-Null

Write-Host "Downloading CLI..."
Write-Host "URL: $Url"

curl.exe -L --fail --show-error -o "$tmp" "$Url"

if ($LASTEXITCODE -ne 0) {
    Write-Err "CLI download failed"
}

Write-Ok "Downloaded to $tmp"

if (-not (Test-Path $tmp)) {
    Write-Err "Zip missing"
}

$size = (Get-Item $tmp).Length
if ($size -lt 100000) {
    Write-Err "Downloaded file too small (likely failed)"
}

Write-Host "Extracting CLI..."
Expand-Archive -Path $tmp -DestinationPath $InstallDir -Force
Write-Ok "Extraction complete"

Remove-Item $tmp -Force

@"
@echo off
"%~dp0..\cli\ix-$Version-windows-amd64\ix.cmd" %*
"@ | Out-File "$IxBin\ix.cmd" -Encoding ascii

$userPath = [Environment]::GetEnvironmentVariable("PATH","User")
if ($userPath -notlike "*$IxBin*") {
    [Environment]::SetEnvironmentVariable("PATH","$IxBin;$userPath","User")
}

$env:Path = "$IxBin;$env:Path"

Write-Ok "CLI installed"

# test CLI
Write-Host "Testing CLI..."

$out = cmd /c "ix --version 2>&1"

if ($LASTEXITCODE -ne 0) {
    Write-Warn "CLI test failed"
    $out | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Ok "CLI working: $out"
}

# ── Done ──
Write-Host "`nIx is ready`n"
Pause-On-Failure
