#!/usr/bin/env pwsh
# install.ps1 — Windows installer for ix CLI
# Usage:
#   irm https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.ps1 | iex
#   .\install.ps1 -Version 0.5.0 -NoModifyPath

param(
    [string]$Version = "",
    [switch]$NoModifyPath
)

$ErrorActionPreference = 'Stop'

# --- Detect architecture ---------------------------------------------------

function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64"  { return "x64" }
        "ARM64"  { return "arm64" }
        default  { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
    }
}

# --- Resolve latest version from GitHub ------------------------------------

function Get-LatestVersion {
    $apiUrl = "https://api.github.com/repos/ix-infrastructure/IX-Memory/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "ix-installer" }
        $tag = $release.tag_name -replace '^v', ''
        return $tag
    }
    catch {
        throw "Failed to fetch latest release from GitHub: $_"
    }
}

# --- Main ------------------------------------------------------------------

Write-Host ""
Write-Host "  ix memory installer" -ForegroundColor Cyan
Write-Host "  ====================" -ForegroundColor Cyan
Write-Host ""

$arch = Get-Arch
Write-Host "  Detected architecture: $arch" -ForegroundColor Gray

# Resolve version
if ([string]::IsNullOrWhiteSpace($Version)) {
    Write-Host "  Fetching latest version..." -ForegroundColor Gray
    $Version = Get-LatestVersion
}
Write-Host "  Version: $Version" -ForegroundColor Gray

# Paths
$installDir = Join-Path $env:LOCALAPPDATA "ix"
$binPath    = Join-Path $installDir "ix.exe"
$tarball    = "ix-${Version}-windows-${arch}.tar.gz"
$downloadUrl = "https://github.com/ix-infrastructure/IX-Memory/releases/download/v${Version}/${tarball}"
$checksumUrl = "${downloadUrl}.sha256"
$tempDir     = Join-Path ([System.IO.Path]::GetTempPath()) "ix-install-$([System.Guid]::NewGuid().ToString('N'))"

# Create temp directory
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    # Download tarball
    $tarballPath = Join-Path $tempDir $tarball
    Write-Host "  Downloading $tarball..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tarballPath -UseBasicParsing

    # Download and verify checksum
    $checksumPath = Join-Path $tempDir "${tarball}.sha256"
    Write-Host "  Verifying checksum..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing

    $expectedHash = (Get-Content $checksumPath -Raw).Trim().Split(" ")[0].ToUpper()
    $actualHash   = (Get-FileHash -Path $tarballPath -Algorithm SHA256).Hash.ToUpper()

    if ($expectedHash -ne $actualHash) {
        throw "Checksum mismatch!`n  Expected: $expectedHash`n  Actual:   $actualHash"
    }
    Write-Host "  Checksum verified." -ForegroundColor Green

    # Create install directory
    if (!(Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Extract tarball
    Write-Host "  Extracting to $installDir..." -ForegroundColor Yellow
    tar -xzf $tarballPath -C $installDir

    # Add to PATH
    if (-not $NoModifyPath) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -notlike "*$installDir*") {
            [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
            Write-Host "  Added $installDir to user PATH." -ForegroundColor Green
        }
        else {
            Write-Host "  Install directory already in PATH." -ForegroundColor Gray
        }
        # Update current session PATH as well
        $env:Path = "$env:Path;$installDir"
    }
    else {
        Write-Host "  Skipped PATH modification (--NoModifyPath)." -ForegroundColor Gray
    }

    # Write manifest
    $manifest = @{
        version     = $Version
        platform    = "windows"
        arch        = $arch
        installDir  = $installDir
        installDate = (Get-Date -Format "o")
    } | ConvertTo-Json -Depth 2

    $manifestPath = Join-Path $installDir "manifest.json"
    Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
    Write-Host "  Wrote manifest to $manifestPath" -ForegroundColor Gray

    # Verify installation
    Write-Host ""
    Write-Host "  Verifying installation..." -ForegroundColor Yellow
    $verifyOutput = & $binPath --version 2>&1
    Write-Host "  ix $verifyOutput" -ForegroundColor Green

    # Success
    Write-Host ""
    Write-Host "  Installation complete!" -ForegroundColor Green
    Write-Host "  Binary:  $binPath" -ForegroundColor Gray
    Write-Host "  Version: $Version" -ForegroundColor Gray
    Write-Host ""
    if (-not $NoModifyPath) {
        Write-Host "  Restart your terminal, then run: ix --help" -ForegroundColor Cyan
    }
    else {
        Write-Host "  Add $installDir to your PATH, then run: ix --help" -ForegroundColor Cyan
    }
    Write-Host ""
}
finally {
    # Clean up temp directory
    if (Test-Path $tempDir) {
        Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    }
}
