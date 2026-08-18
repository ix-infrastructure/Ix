# ─────────────────────────────────────────────────────────────────────────────
# Ix — Windows Installer (PowerShell)
#
# Environment:
#   $env:IX_VERSION = "0.9.0-rc.1"   Install a specific release (default: latest
#                                    stable; required for a release candidate)
#   $env:IX_HOME    = "C:\ix"        Install root (default: $env:USERPROFILE\.ix)
#   $env:IX_SKIP_BACKEND = "1"       Install the CLI only, no Docker backend
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

# Installer scratch files live under $IxHome, never under $env:TEMP.
#
# #349: on a profile at `C:\Users\Win 10`, Windows hands the installer a TEMP
# path in 8.3 short form and the run dies after extraction. The reporter
# confirmed that pointing TEMP and TMP at a path without a space lets the same
# install finish, so the short TEMP path is what breaks it.
#
# The issue quotes the error verbatim as
#   An object at the specified path C:\Users\WIN10\~1 does not exist.
# -- note the backslash before `~1`. Probably a copy artifact, since
# `C:\Users\WIN10~1` is the 8.3 alias of `C:\Users\Win 10` and a literal `~1`
# directory makes no sense, but it has not been confirmed with the reporter and
# the 8.3 reading depends on that one character. Quoted as written rather than
# normalised, because the whole point of the block below is which parts of this
# are established.
#
# $IxHome comes from USERPROFILE, which is the long form. $Staging was already
# there, so moving these two takes the script off TEMP completely.
#
# What is NOT established is which call fails, or why -- treat the mechanism as
# open until a fresh transcript says otherwise:
#   - The provider cmdlets this script runs on the zip (`Test-Path
#     -LiteralPath`, `Get-Item -LiteralPath`) resolve 8.3 segments fine on both
#     Windows PowerShell 5.1 and 7, and the reporter's transcript shows them
#     succeeding -- extraction completes before the error appears.
#   - `Expand-Archive` resolves through the provider too (Resolve-Path in
#     Microsoft.PowerShell.Archive), so this is not a Win32-vs-provider split.
#   - That error string could not be reproduced from any cmdlet this script
#     calls; the ones that fail on a missing path say "Cannot find path".
# The likeliest remaining explanation is that 8.3 alias *creation* is disabled
# on that volume while TEMP still carries a stale short path, so nothing
# resolves it. Moving off TEMP fixes that reading too, which is why this is
# worth shipping ahead of the diagnosis.
#
# `ix upgrade` originally retained the same os.tmpdir()/TEMP exposure. #392
# moved its CLI and Compass download scratch under IX_HOME as well.
#
# The `.cli-staging-` prefix on both scratch names is deliberate:
# sweepUpgradeOrphans in upgrade.ts reclaims `.cli-staging-*` out of IX_HOME.
# It must not be `.cli-backup-`: that prefix is a *recovery* candidate there,
# and a leftover zip would be renamed over the install directory on the next
# upgrade.

# ── Helpers ──────────────────────────────────────────────────────────────────

function Pause-On-Failure {
    if ($Host.Name -eq "ConsoleHost") {
        Write-Host ""
        Read-Host "Press Enter to exit"
    }
}

function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
# Leaving TEMP also left the OS's own cleanup, so every exit has to clear its
# own scratch. sweepUpgradeOrphans covers a process killed outright, but it runs
# only from `ix upgrade` and only when an update is actually available -- and a
# first install that dies at the download leaves no `ix` on the machine to ever
# run it, so a partial multi-MB zip would sit in ~/.ix forever. Write-Err is the
# single exit for every failure below, which makes it the one place this has to
# be right.
#
# Rebuilds the two names from $IxHome and $PID rather than reading $tmp and
# $pullLog. README ships this as `irm ... | iex`, so the script body runs in the
# *caller's* scope -- the same hazard the $Matches note below already calls out.
# Every Write-Err above the assignments (and all of them, on the re-run path,
# where $pullLog is never assigned because the backend is already healthy) would
# otherwise read whatever the user's own session had in those names and delete
# it. $IxHome is assigned unconditionally at the top, long before any Write-Err
# is reachable, so it is always ours.
#
# -PathType Leaf so a *directory* sitting on either name is skipped rather than
# removed. (Not $Staging -- that is `.cli-staging-<pid>` with no suffix and
# cannot collide with the `.zip`/`.log` names built here.) Two measured cases:
# a stale directory squatting the exact name, where `Remove-Item -Force` on one
# with children throws, since there is no host UI for the prompt and
# -ErrorAction SilentlyContinue does not catch it; and a junction at that name,
# where the guard keeps the installer from deleting a reparse point it did not
# create, and turns 5.1's NullReferenceException into a clean skip. Neither
# host recurses into a junction's target without -Recurse, so that is not the
# risk being avoided.
#
# The whole body is wrapped because this runs *from the error path*: anything
# escaping lands in the trap and prints a second, meaningless error over the
# actionable one. Under `$ErrorActionPreference = "Stop"` the two statements
# fail on different inputs, which is why guarding one of them is not enough --
# with IX_HOME on a detached drive it is `Join-Path` that throws
# DriveNotFoundException, on both 5.1 and 7, before Test-Path is ever reached;
# with illegal characters in the path `Join-Path` returns and `Test-Path`
# throws ArgumentException, on 5.1 only. Best-effort cleanup must never be the
# loudest thing in the output.
function Remove-InstallerScratch {
    if (-not $IxHome) { return }
    try {
        foreach ($name in @(".cli-staging-$PID.zip", ".cli-staging-pull-$PID.log")) {
            $p = Join-Path $IxHome $name
            if (Test-Path -LiteralPath $p -PathType Leaf) {
                Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # Deliberately silent: see above.
    }
}

function Write-Err($msg) {
    Write-Host "  [error] $msg" -ForegroundColor Red
    Remove-InstallerScratch
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

# Get-CompassLatestVersion was removed with Ix#376: the compass this script
# installs comes from the release tarball, so the latest ix-compass-dist release
# number was never the right thing to stamp it with. `ix upgrade` asks that
# question, at a point where it can also tell which series the bundle is in.

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
#
# `IX_SKIP_BACKEND` is not new: install.sh has honoured it since it was written,
# and it is the very thing install.sh *tells a Windows user to do* when it
# declines to install Docker for them ("To install the CLI only (no backend):
# IX_SKIP_BACKEND=1 sh install.sh"). This script never implemented it, so the
# advice pointed at a flag that did nothing here and there was no way to install
# the CLI against a memory layer that already exists — a remote endpoint, a
# backend on another host, or a machine where Docker is managed separately.
#
# Both sections are gated, not just the second: `Write-Err` exits, so an absent
# Docker ends the run before the CLI is ever unpacked.
$SkipBackend = $env:IX_SKIP_BACKEND -eq "1"

Write-Host "`n-- Docker --"

if ($SkipBackend) {
    Write-Host "  (skipped via IX_SKIP_BACKEND=1)"
} else {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Err "Docker not installed"
    }

    Write-Ok "Docker installed"

    if (-not (Test-DockerRunning)) {
        Write-Err "Docker not running"
    }

    Write-Ok "Docker running"
}

# ── Backend ──
Write-Host "`n-- Backend --"

if ($SkipBackend) {
    Write-Host "  (skipped via IX_SKIP_BACKEND=1)"
} elseif (Test-Healthy) {
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
    $pullLog = Join-Path $IxHome ".cli-staging-pull-$PID.log"
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
$tmp = "$IxHome\.cli-staging-$PID.zip"
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

# Checks its own target before invoking it. `ix upgrade` on any version before
# 0.9.0 refreshed only the bash shim and left this file pointing at a
# `cli\ix.cmd` the upgrade had just replaced with a version-nested directory
# (Ix#385). cmd.exe's own error names this wrapper rather than the cause, and
# the CLI that would explain it is exactly as unreachable as the launcher — so
# the recovery instruction has to live here. `^|` is an escaped pipe.
@"
@echo off
if not exist "%~dp0..\cli\ix.cmd" goto :ix_missing
"%~dp0..\cli\ix.cmd" %*
exit /b %errorlevel%

:ix_missing
echo(
echo   The Ix CLI is not at "%~dp0..\cli\ix.cmd".
echo(
echo   An 'ix upgrade' from a version before 0.9.0 moved the CLI and left
echo   this launcher pointing at the old path. Reinstalling repairs it:
echo(
echo     irm https://ix-infra.com/install.ps1 ^| iex
echo(
exit /b 1
"@ | Out-File -LiteralPath "$IxBin\ix.cmd" -Encoding ascii

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
#
# The compass installed here always comes from the release tarball, never from
# ix-compass-dist — so it must be stamped as a *release* bundle. This used to
# write the latest ix-compass-dist release number instead, which mislabelled a
# release bundle as a dist build and clobbered the correct stamp the tarball
# already carried, leaving `ix upgrade` ready to downgrade a newer bundled
# compass to an older dist build (Ix#376). Prefer the tarball's own stamp; only
# write one if the bundle has none (zips up to v0.9.2 predate it).
#
# Unlike install.sh this needs no "did we extract?" guard: there is no
# already-current skip path here, so the compass under cli\ always came from the
# zip this run just unpacked and really is a release bundle.
#
# One line, and semver build metadata rather than key=value — see the note in
# release.yml. Every already-shipped CLI reads this file whole and feeds it to
# splitVersion, so a second line makes the version parse as 0 and hands an old
# CLI a reason to replace this bundle with an older dist build.
$CompassDir = Join-Path $IxHome "cli\compass"
$CompassIndex = Join-Path $CompassDir "index.html"
$CompassStamp = Join-Path $CompassDir ".version"
if (Test-Path -LiteralPath $CompassIndex) {
    $HasStamp = (Test-Path -LiteralPath $CompassStamp) -and `
        ((Get-Item -LiteralPath $CompassStamp).Length -gt 0)
    if (-not $HasStamp) {
        [System.IO.File]::WriteAllText($CompassStamp, "$Version+release`n")
    }
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
