# ─────────────────────────────────────────────────────────────────────────────
# Ix — Windows Installer (PowerShell)
#
# Environment:
#   $env:IX_VERSION = "0.9.0-rc.1"   Install a specific release (default: latest
#                                    stable; required for a release candidate)
#   $env:IX_HOME    = "C:\ix"        Install root (default: $env:USERPROFILE\.ix)
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
        # -UseBasicParsing, or Windows PowerShell hands the response to the IE
        # engine and stops the install on an interactive "Script Execution Risk"
        # prompt that defaults to No. It only fires once a backend is actually
        # up and returning a body — a first install has nothing listening, the
        # request fails outright, and the parse never happens. So this bites on
        # re-runs and upgrades, never on the machine you first tested. Both
        # endpoints return JSON that nothing here reads; only the status matters.
        $null = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        $null = Invoke-WebRequest -Uri $ArangoUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Get-LatestVersion {
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$GithubOrg/$GithubRepo/releases/latest"
        return $release.tag_name -replace '^v',''
    } catch { return "0.6.0" }
}

function Resolve-Version {
    # Mirrors resolve_version() in install.sh, IX_VERSION included. That
    # override is the only way to install a release candidate from either
    # script: /releases/latest excludes prereleases by design, so the network
    # path above always resolves to the last stable build no matter what was
    # tagged most recently.
    if ($env:IX_VERSION) { return $env:IX_VERSION }
    return Get-LatestVersion
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

$Version = Resolve-Version
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

New-Item -ItemType Directory -Force -Path $IxBin | Out-Null

Write-Host "Downloading CLI..."
Write-Host "URL: $Url"

curl.exe -L --fail --show-error -o "$tmp" "$Url"

if ($LASTEXITCODE -ne 0) {
    Write-Err "CLI download failed"
}

Write-Ok "Downloaded to $tmp"

if (-not (Test-Path -LiteralPath $tmp)) {
    Write-Err "Zip missing"
}

$size = (Get-Item -LiteralPath $tmp).Length
if ($size -lt 100000) {
    Write-Err "Downloaded file too small (likely failed)"
}

Write-Host "Extracting CLI..."

# The zip nests everything under ix-<version>-windows-amd64\, and Expand-Archive
# has no --strip-components. Extracting straight into cli\ therefore produced
# cli\ix-<version>-windows-amd64\compass\, while the CLI only ever looks in
# cli\compass (COMPASS_DIR in upgrade.ts, findCompassDist in view.ts). Every
# Windows install shipped a Compass that `ix view` could not see and fell back
# to a network repair that is not guaranteed to work — so `ix view` was broken
# on Windows even when the release bundled Compass correctly.
#
# Collapse that directory here. install.sh has always stripped it via tar, and
# `ix upgrade` already resolves either shape, so this makes a fresh Windows
# install match both.
# `.cli-staging-<pid>`, not a fixed name: sweepUpgradeOrphans in upgrade.ts
# reclaims `.cli-staging-*` and `.cli-backup-*`, so an installer killed
# mid-extract is cleaned up by the next `ix upgrade` instead of leaking a copy
# of the release into IX_HOME forever. The pid also keeps two concurrent runs
# from sharing a staging directory.
$Staging = "$IxHome\.cli-staging-$PID"
Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Staging | Out-Null
# -LiteralPath: -Path glob-expands, so a home directory containing [ or ] takes
# these off the real file — measured on 5.1, `Test-Path` returns False for a
# file that exists and `Remove-Item` silently no-ops. extractZipOnWindows in
# upgrade.ts already uses it for this reason. Applied to every path-taking
# cmdlet from the download onwards, not just this block: the zip's own
# Test-Path/Get-Item run first, so hardening only the extract would still have
# left the installer dying at "Zip missing" on such a home.
Expand-Archive -LiteralPath $tmp -DestinationPath $Staging -Force

# Exactly one directory, not merely the first of several — the same rule
# soleChildDir applies in upgrade.ts. `Select-Object -First 1` would pick one
# of several arbitrarily and could collapse the wrong tree into cli\.
# -Force counts hidden directories, so this stays the same test install.sh
# makes with `find -type d`, which counts them too.
$TopDirs = @(Get-ChildItem -LiteralPath $Staging -Directory -Force)
if ($TopDirs.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $TopDirs[0].FullName "ix.cmd"))) {
    Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
    Write-Err "Extracted archive is not an ix release: expected one top-level directory containing ix.cmd, found $($TopDirs.Count). Left the existing install untouched."
}
$Extracted = $TopDirs[0]

# Swap only once the new tree is known good, and move the old one aside instead
# of deleting it so a failed move can be undone. Deleting first is what left
# Windows users with no CLI at all in #337.
$Backup = "$IxHome\.cli-backup-$PID"

# Clear the backup path first, as swapInStagedTree does with rmQuiet(backupDir).
# Directory::Move refuses to move onto an existing destination, so a stale
# .cli-backup-<pid> — left by an earlier run that died mid-swap, on a pid Windows
# has since reused — would abort the swap. Check it actually went: -ErrorAction
# SilentlyContinue hides a removal that *failed* exactly as well as one that had
# nothing to do, and a locked leftover would otherwise send the swap in blind.
Remove-Item -Recurse -Force -LiteralPath $Backup -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $Backup) {
    Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
    Write-Err "Could not clear a leftover backup at $Backup. Remove it and re-run. Left the existing install untouched."
}

# [System.IO.Directory]::Move, not Move-Item.
#
# Move-Item on a directory falls back to a recursive copy-then-delete whenever
# the rename cannot be done, and then throws *part way through* — leaving the
# tree split across both paths, ix.cmd in the backup and cli\dist\cli\main.js
# still in cli\. The restore below cannot fire in that state, because it guards
# on `-not (Test-Path $InstallDir)` and $InstallDir still exists. So the branch
# written to protect the user's CLI is skipped in precisely the case that
# destroyed it, and the installer exits reporting only the lock message.
#
# On Windows an open handle under cli\ is routine rather than exotic: a running
# `ix view` serving compass out of cli\compass, `ix watch` holding tree-sitter's
# .node addons mapped for the life of the process, or Defender scanning the
# native modules the extract just wrote.
#
# Directory::Move is a plain rename — it either happens or the source is left
# untouched, and it will not move a directory *inside* an existing destination
# the way Move-Item does. That is the atomicity swapInStagedTree gets for free
# from fs.renameSync, and which this block only claimed to match.
try {
    if (Test-Path -LiteralPath $InstallDir) { [System.IO.Directory]::Move($InstallDir, $Backup) }
    [System.IO.Directory]::Move($Extracted.FullName, $InstallDir)
    Remove-Item -Recurse -Force -LiteralPath $Backup -ErrorAction SilentlyContinue
} catch {
    # Capture before the nested try below rebinds $_, and unwrap the
    # MethodInvocationException so the message is the IO error itself rather
    # than 'Exception calling "Move" with "2" argument(s)'.
    $failure = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
    if ((Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath $InstallDir)) {
        try {
            [System.IO.Directory]::Move($Backup, $InstallDir)
            Write-Warn "Restored the previous CLI after a failed update."
        } catch {
            # Name the surviving copy, the way upgrade.ts does when its own
            # restore fails. Without this the user cannot tell that the install
            # is gone rather than merely unchanged.
            Write-Warn "Your previous CLI is still at $Backup — rename it to $InstallDir to restore it."
        }
    }
    Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
    Write-Err "Could not install to $InstallDir : $failure"
}
Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
Write-Ok "Extraction complete"

Remove-Item -LiteralPath $tmp -Force

@"
@echo off
"%~dp0..\cli\ix.cmd" %*
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
#
# This tests the path the CLI actually reads (COMPASS_DIR in upgrade.ts,
# findCompassDist in view.ts). The extraction above collapses the archive's
# top-level directory, so that is now also where the bundled compass lands and
# this branch stamps a bundle `ix view` can genuinely serve. Keep the Test-Path
# on index.html: stamping a version for a compass that is not on disk is what
# made `ix upgrade` skip the repair download and break `ix view` permanently.
# The warning below is now a real failure signal, not the normal Windows path.
$CompassVer = Get-CompassLatestVersion
$CompassDir = Join-Path $IxHome "cli\compass"
$CompassIndex = Join-Path $CompassDir "index.html"
if ($CompassVer -and (Test-Path -LiteralPath $CompassIndex)) {
    [System.IO.File]::WriteAllText((Join-Path $CompassDir ".version"), $CompassVer)
} elseif (-not (Test-Path -LiteralPath $CompassIndex)) {
    Write-Warn "System Compass is not installed at $CompassDir — 'ix view' is unavailable until you run 'ix upgrade', which will fetch it."
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
