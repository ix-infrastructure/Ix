# ─────────────────────────────────────────────────────────────────────────────
# Ix — Windows Uninstaller (PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/ix-infrastructure/Ix/main/uninstall.ps1 | iex
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$IxHome = if ($env:IX_HOME) { $env:IX_HOME } else { "$env:USERPROFILE\.ix" }
$IxBin = "$IxHome\bin"
$ComposeDir = "$IxHome\backend"

function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "+" + ("=" * 42) + "+" -ForegroundColor Cyan
Write-Host "|       Ix - Uninstall              |" -ForegroundColor Cyan
Write-Host "+" + ("=" * 42) + "+" -ForegroundColor Cyan
Write-Host ""

# ── 1. Stop backend ─────────────────────────────────────────────────────────

Write-Host "-- Removing backend --"
if (Test-Path "$ComposeDir\docker-compose.yml") {
    try {
        if ($env:IX_KEEP_DATA -eq "1") {
            docker compose -f "$ComposeDir\docker-compose.yml" down 2>&1 | Out-Null
            Write-Ok "Stopped backend (data preserved)"
        } else {
            docker compose -f "$ComposeDir\docker-compose.yml" down -v 2>&1 | Out-Null
            Write-Ok "Stopped backend and removed data"
        }
    } catch {
        Write-Host "  (could not stop containers — Docker may not be running)"
    }
} else {
    Write-Host "  (no backend found — skipping)"
}

# ── 2. Remove CLI ───────────────────────────────────────────────────────────

Write-Host ""
Write-Host "-- Removing ix CLI --"

if (Test-Path "$IxBin\ix.cmd") {
    Remove-Item "$IxBin\ix.cmd" -Force
    Write-Ok "Removed $IxBin\ix.cmd"
}

# Remove from PATH
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -like "*$IxBin*") {
    $newPath = ($userPath -split ';' | Where-Object { $_ -ne $IxBin }) -join ';'
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-Ok "Removed $IxBin from user PATH"
}

# ── 3. Remove IX home ───────────────────────────────────────────────────────

Write-Host ""
Write-Host "-- Cleaning up --"

if (Test-Path $IxHome) {
    Remove-Item $IxHome -Recurse -Force
    Write-Ok "Removed $IxHome"
}

Write-Host ""
Write-Host "  Done. Ix has been uninstalled."
Write-Host "  Open a new terminal for PATH changes to take effect."
Write-Host ""
