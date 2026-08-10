# Ix skill bootstrap (Windows PowerShell) - install the ix CLI, start the local
# backend, and map a repo.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 [repo-root] [-NoMap] [-NoBackend]
#
# Requires: Node.js >= 22, git, Docker Desktop (running), ripgrep (for `ix text`, optional).
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 files
# without a BOM as ANSI, so non-ASCII bytes (e.g. an em dash) get misparsed as
# smart quotes and break the script.

param(
  [string]$Repo = "",
  [switch]$NoMap,
  [switch]$NoBackend
)

$ErrorActionPreference = "Stop"
function Info  { Write-Host "[ix-skill] $args" -ForegroundColor Cyan }
function Warn  { Write-Host "[ix-skill] $args" -ForegroundColor Yellow }
function Fail  { Write-Host "[ix-skill] $args" -ForegroundColor Red; exit 1 }

if (-not $Repo) { $Repo = (Get-Location).Path }
Info "Ix skill bootstrap - repo: $Repo"

# --- Prerequisites ------------------------------------------------------------
$nodeVer = ""
try { $nodeVer = (node --version).TrimStart("v") } catch {}
if ($nodeVer) {
  if ([version]$nodeVer -ge [version]"22.0.0") { Info "Node $nodeVer OK." }
  else { Warn "Node $nodeVer detected; Ix requires Node >= 22 (https://nodejs.org)." }
} else {
  Warn "Node.js not found; Ix requires Node >= 22 (https://nodejs.org)."
}

try { git --version | Out-Null; Info "git OK." } catch { Warn "git not found; Ix uses it for workspace detection." }
try { rg --version | Out-Null; Info "ripgrep OK (powers 'ix text')." } catch { Warn "ripgrep not found - 'ix text' will not work. Install: choco install ripgrep" }

$dockerUp = $false
try {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { $dockerUp = $true; Info "Docker daemon is running." }
} catch {}
if (-not $dockerUp) {
  Warn "Docker daemon is NOT running. Start Docker Desktop first, then re-run this script."
  $NoBackend = $true
}

# --- Resolve the ix CLI ---------------------------------------------------------
# The installer registers ~/.ix\bin in the user PATH, but long-lived shells and
# agents spawned before the install may not see it. Resolve it before deciding
# whether to install.
$ixBin = Join-Path $env:USERPROFILE ".ix\bin"
if (-not (Get-Command ix -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $ixBin "ix.cmd")) { $env:Path = "$ixBin;$env:Path"; Info "Found ix at ~/.ix\bin - added to PATH for this session." }
}

# --- Install the ix CLI (only if still missing) ---------------------------------
if (Get-Command ix -ErrorAction SilentlyContinue) {
  Info "ix CLI already installed."
} elseif ($env:IX_SKIP_INSTALL -eq "1") {
  Warn "IX_SKIP_INSTALL=1 - skipping ix CLI install. 'ix' is not on PATH."
} else {
  Info "Installing the ix CLI (official installer)..."
  Invoke-RestMethod https://ix-infra.com/install.ps1 | Invoke-Expression
  if (-not (Get-Command ix -ErrorAction SilentlyContinue)) {
    $ixBin2 = Join-Path $env:USERPROFILE ".ix\bin"
    if (Test-Path (Join-Path $ixBin2 "ix.cmd")) { $env:Path = "$ixBin2;$env:Path" }
  }
  if (-not (Get-Command ix -ErrorAction SilentlyContinue)) {
    Fail "ix CLI install finished but 'ix' is still not on PATH. Restart your shell, then re-run this script."
  }
  Info "ix CLI installed."
}
if (-not (Get-Command ix -ErrorAction SilentlyContinue)) {
  Fail "The ix CLI is not on PATH. Run the official installer, restart your shell, then re-run this bootstrap."
}

# --- Compass (visualizer UI) ----------------------------------------------------
# The installer re-extracts the CLI tarball over the ix home and wipes the
# Compass assets, which ship only via `ix upgrade`. Ensure they exist so
# `ix view` never silently breaks after an installer re-run.
if ($env:IX_SKIP_COMPASS -ne "1") {
  $ixHome = Join-Path $env:USERPROFILE ".ix"
  if ($env:IX_HOME) { $ixHome = $env:IX_HOME }
  $compassIndex = Join-Path $ixHome "cli\compass\index.html"
  if (Test-Path $compassIndex) {
    Info "Compass UI present."
  } else {
    Warn "Compass UI missing at $ixHome\cli\compass (a re-install likely wiped it) - running 'ix upgrade' to restore it."
    try { ix upgrade } catch { Warn "'ix upgrade' failed - 'ix view' will be unavailable until it is re-run." }
  }
}

# --- Backend -------------------------------------------------------------------
if (-not $NoBackend) {
  Info "Starting the Ix backend (ArangoDB + memory layer)..."
  try { ix docker start } catch { Warn "`ix docker start` reported a problem - run `ix doctor` and `ix status`." }
  for ($i = 0; $i -lt 15; $i++) {
    if (ix status *> $null) { break }
    Start-Sleep -Seconds 2
  }
  try { ix status } catch { Warn "Backend still not reachable. Run: ix docker start; ix doctor" }
}

# --- Map the repo ---------------------------------------------------------------
if (-not $NoMap) {
  Info "Mapping $Repo - this builds the persistent graph (can take a while on large repos)..."
  Push-Location $Repo
  try { ix map . } finally { Pop-Location }
}

Info "Done. Try: ix explain <symbol>, ix trace <flow>, ix impact <symbol> --format llm"
