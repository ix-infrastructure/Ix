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
$NodeMinMajor = 22

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

function Get-BackendLatestVersion {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GithubOrg/ix-memory-layer-dist/releases/latest" -ErrorAction Stop
        return $release.tag_name -replace '^v', ''
    } catch {
        return $null
    }
}

function Get-CompassLatestVersion {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GithubOrg/ix-compass-dist/releases/latest" -ErrorAction Stop
        return $release.tag_name -replace '^v', ''
    } catch {
        return $null
    }
}

# ══════════════════════════════════════════════════════════════════════════════

Write-Host "`nIx Installer`n"

$Version = Get-LatestVersion
Write-Host "Version: $Version"

# ── Node ──
Write-Host "`n-- Node.js --"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    # Actually enforce $NodeMinMajor. Until now this check was existence-only,
    # so $NodeMinMajor was dead and a Windows user on an unsupported Node got
    # through the installer cleanly, then hit the CLI's own runtime guard on
    # their first `ix` command. install.sh has always enforced its floor.
    # [regex]::Match rather than -match: if `node -v` ever prints more than one
    # line, -match becomes the filter operator and leaves $Matches untouched --
    # which either throws on a null index, or silently reuses a stale $Matches
    # from the caller's scope, since README ships this as `irm ... | iex`.
    # @(...) rather than `| Select-Object -First 1`: -First halts the native
    # command with StopUpstreamCommandsException, which loses $LASTEXITCODE on
    # 7 and sets it to -1 on 5.1. Array-wrapping keeps the exit code, and
    # yields "" rather than AutomationNull when node prints nothing -- casting
    # AutomationNull to [string] hands Match() a real null, which throws.
    $nodeLines = @(& node -v)
    $nodeVer = if ($nodeLines.Count -gt 0) { $nodeLines[0] } else { "" }
    $nodeMatch = [regex]::Match($nodeVer, '^v?(\d+)')
    if (-not $nodeMatch.Success) {
        Write-Err "Could not read the Node version (node -v printed '$nodeVer'). Ix requires Node $NodeMinMajor or newer: https://nodejs.org/"
    }
    $nodeMajor = [int]$nodeMatch.Groups[1].Value
    if ($nodeMajor -lt $NodeMinMajor) {
        Write-Err "Node $nodeVer is too old. Ix requires Node $NodeMinMajor or newer: https://nodejs.org/"
    }
    Write-Ok "Node $nodeVer"
} else {
    Write-Err "Node not installed. Ix requires Node $NodeMinMajor or newer: https://nodejs.org/"
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

    # Capture the compose output so a failed pull can be diagnosed instead of
    # reported as a bare "Docker compose failed". Tee keeps it on screen too.
    $pullLog = Join-Path $env:TEMP "ix-pull-$PID.log"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # ForEach-Object stringifies before Tee: on Windows PowerShell 5.1
        # docker writes progress to stderr, and `2>&1` turns those lines into
        # ErrorRecords, which the host renders as red NativeCommandError blocks
        # even on a successful install. "$_" flattens them to plain strings;
        # $LASTEXITCODE and docker's own text in the log are unaffected (the
        # log actually gets cleaner -- PowerShell's error framing stops being
        # written into it alongside docker's lines).
        docker compose -f "$composeFile" up -d --pull always 2>&1 |
            ForEach-Object { "$_" } |
            Tee-Object -FilePath $pullLog
    } finally {
        $ErrorActionPreference = $prevEap
    }

    if ($LASTEXITCODE -ne 0) {
        $pullOut = ""
        if (Test-Path $pullLog) { $pullOut = Get-Content $pullLog -Raw }
        Remove-Item $pullLog -Force -ErrorAction SilentlyContinue

        Write-Host ""
        # Match 429 only where it is HTTP status text. A bare 429 also matches
        # ordinary pull progress -- "429.4MB/1.02GB" -- which would send a GHCR
        # denial to the Docker Hub branch and give exactly the wrong advice,
        # the bug this whole change exists to fix. Both spellings are needed:
        # Docker Hub's edge limiter can surface as "error parsing HTTP 429
        # response body: ... Too Many Requests (HAP429)", which carries neither
        # "toomanyrequests" nor a spaceless "429 Too Many Requests".
        if ($pullOut -match "(?i)toomanyrequests|rate limit|429 too many requests|http 429") {
            Write-Host "  +-------------------------------------------------------------+"
            Write-Host "  |  Docker Hub rate-limited the pull.                          |"
            Write-Host "  |                                                             |"
            Write-Host "  |  Docker Hub limits unauthenticated pulls to 100 per 6hrs.   |"
            Write-Host "  |  Sign in to Docker Hub (free account) to raise the limit:   |"
            Write-Host "  |                                                             |"
            Write-Host "  |    docker login                                             |"
            Write-Host "  |                                                             |"
            Write-Host "  |  Then re-run this installer.                                |"
            Write-Host "  +-------------------------------------------------------------+"
        } elseif ($pullOut -match "(?i)denied|unauthorized") {
            Write-Host "  +-------------------------------------------------------------+"
            Write-Host "  |  Docker was denied access to the Ix backend image.          |"
            Write-Host "  |                                                             |"
            Write-Host "  |  This image is public and needs no login. This error        |"
            Write-Host "  |  usually means Docker is sending stale ghcr.io              |"
            Write-Host "  |  credentials from an earlier login, and GHCR rejects        |"
            Write-Host "  |  them instead of falling back to an anonymous pull.         |"
            Write-Host "  |                                                             |"
            Write-Host "  |    docker logout ghcr.io                                    |"
            Write-Host "  |                                                             |"
            Write-Host "  |  Then re-run this installer.                                |"
            Write-Host "  +-------------------------------------------------------------+"
        } else {
            # Fail safe, the way install.sh already does: if neither pattern
            # matched, show the output rather than swallowing it behind a bare
            # "Docker compose failed". $pullLog is gone by here, so use $pullOut.
            Write-Host "  Image pull failed. Error output:"
            ($pullOut -split "`r?`n" | Select-Object -First 20) | ForEach-Object { Write-Host "  $_" }
            Write-Host ""
            Write-Host "  If Docker just started, it may need a moment - try again."
        }

        Write-Err "Docker compose failed"
    }

    Remove-Item $pullLog -Force -ErrorAction SilentlyContinue

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

# Stamp installed versions so upgrade checker doesn't nag
$BackendVer = Get-BackendLatestVersion
if ($BackendVer) {
    [System.IO.File]::WriteAllText((Join-Path $IxHome ".backend-version"), $BackendVer)
}

# Only stamp compass if a compass was actually installed. Stamping unconditionally
# created a cli\compass directory containing nothing but a .version file, which made
# `ix upgrade` believe compass was already current (it compares against this stamp)
# and permanently skip the download that would have repaired it — so `ix view`
# stayed broken forever.
$CompassVer = Get-CompassLatestVersion
$CompassDir = Join-Path $IxHome "cli\compass"
$CompassIndex = Join-Path $CompassDir "index.html"
if ($CompassVer -and (Test-Path $CompassIndex)) {
    [System.IO.File]::WriteAllText((Join-Path $CompassDir ".version"), $CompassVer)
} elseif (-not (Test-Path $CompassIndex)) {
    Write-Warn "System Compass was not included in this build — 'ix view' is unavailable. Run 'ix upgrade' to fetch it."
}

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
