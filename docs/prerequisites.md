# System Prerequisites

Everything the Ix installer checks for and installs, and the endpoints and
directories it touches. Reference documentation — not a dependency manifest.

> **Do not move this back to `requirements.txt`, and do not give it a `.txt` or
> `.in` extension.**
>
> Every entry below is a *system* package — curl, git, node, docker, ripgrep —
> and none is a PyPI dependency of this repo. While this file lived at
> `requirements.txt`, GitHub's dependency graph parsed it as pip and recorded
> nine phantom PyPI packages against the repo; seven of those (`arangodb`,
> `docker`, `docker-compose`, `homebrew`, `node`, `npm`, `ripgrep`) are real
> PyPI names owned by unrelated projects, so the SBOM asserted dependencies
> that do not exist. The graph job then failed outright on
> `ix-memory-layer==latest`, which pip cannot parse.
>
> The extension matters as much as the name: Dependabot's pip fetcher
> enumerates `.txt` and `.in` files in the repo root *and one directory deep*,
> then decides by filename or by whether every line parses as a requirement.
> Keeping this as Markdown puts it outside that scan entirely, rather than
> relying on one line staying unparseable.

```
# Ix — System Requirements
#
# Everything listed here is checked and installed by the install script:
#   curl -fsSL https://ix-infra.com/install.sh | sh
#
# Fully automated on macOS and Linux.
# Windows requires manual Docker Desktop install, then re-run.
#
# ============================================================================
#  STEP 0: System prerequisites (auto-installed if missing)
# ============================================================================

# curl or wget — needed to run the install script itself
#   If you ran the curl | sh command, you already have curl.
#   The script also supports wget as a fallback.
curl  # or wget

# Homebrew — macOS package manager (auto-installed on macOS if missing)
#   https://brew.sh — used to install Node, Docker, git
#   Not needed on Linux (uses native package managers).
homebrew  # macOS only

# git — required by ix CLI for workspace detection
#   macOS:   Xcode Command Line Tools or brew install git
#   Linux:   apt/dnf/yum/apk install git
git>=2

# ============================================================================
#  STEP 1: Node.js (auto-installed/upgraded if missing or too old)
# ============================================================================

# Node.js >= 22 (installer targets Node 22 LTS)
#   macOS:   brew install node OR official .pkg installer
#   Linux:   NodeSource apt/dnf/yum repo (setup_22.x) OR apk
#   Windows: manual from https://nodejs.org/
node>=22
npm>=8  # bundled with Node.js

# ============================================================================
#  STEP 2: Docker + Docker Compose (auto-installed if missing)
# ============================================================================

# Docker Engine / Docker Desktop (auto-installed)
#   macOS:   brew install --cask docker OR direct .dmg download
#   Linux:   https://get.docker.com convenience script
#            User added to docker group. systemd service started + enabled.
#   Windows: NOT auto-installed — manual Docker Desktop required.
#
# FIRST LAUNCH (macOS): Docker Desktop shows a license agreement + optional
# sign-in. The script detects this, shows instructions, and waits up to
# 5 minutes. No re-run needed.
#
# RATE LIMITS: Docker Hub limits unauthenticated pulls to 100/6hrs per IP.
# If the pull fails, the script tells the user to run "docker login" (free).
# The Ix Memory Layer image is on GHCR (no rate limits for public images).
docker>=20

# Docker Compose v2 (ships as Docker CLI plugin)
#   Bundled with Docker Desktop and modern Docker Engine.
#   If missing on Linux, the script installs the plugin from GitHub.
docker-compose>=2.0

# ============================================================================
#  STEP 3: Backend services (managed by Docker, no manual install)
# ============================================================================

# ArangoDB 3.12 — graph database (Docker container on 127.0.0.1:8529)
arangodb==3.12

# Ix Memory Layer — Scala/JVM HTTP API (Docker container on 127.0.0.1:8090)
ix-memory-layer==latest

# ============================================================================
#  STEP 4: ix CLI (downloaded as pre-built binary)
# ============================================================================

# Pre-built tarball from GitHub Releases, extracted to ~/.ix/cli/
# Wrapper script placed in /usr/local/bin/ix or ~/.local/bin/ix
# Platforms: linux-amd64, linux-arm64, darwin-arm64, windows-amd64
# No darwin-amd64 (Intel Mac) tarball is published — install with Homebrew,
# which builds from source. The README links here as the full list, so this
# has to agree with it.

# ============================================================================
#  ALSO INSTALLED (used by ix commands)
# ============================================================================

# ripgrep — used by "ix text" for fast codebase text search
#   macOS:   brew install ripgrep
#   Linux:   apt/dnf/apk install ripgrep
#   Falls back to a warning if install fails (non-fatal)
ripgrep>=13

# ============================================================================
#  NETWORK ENDPOINTS ACCESSED
# ============================================================================

# https://api.github.com            — resolve latest release version
# https://github.com                — download CLI tarball
# https://raw.githubusercontent.com — download docker-compose.yml
# https://ghcr.io                   — pull Ix Memory Layer image
# https://nodejs.org                — Node.js installer (macOS no-brew)
# https://deb.nodesource.com        — NodeSource apt (Linux)
# https://rpm.nodesource.com        — NodeSource rpm (Linux)
# https://get.docker.com            — Docker install script (Linux)
# https://desktop.docker.com        — Docker Desktop .dmg (macOS no-brew)
# https://brew.sh                   — Homebrew installer (macOS)

# ============================================================================
#  DIRECTORIES CREATED
# ============================================================================

# ~/.ix/                     Ix home directory
# ~/.ix/config.yaml          CLI configuration
# ~/.ix/backend/             Docker Compose file for local backend
# ~/.ix/cli/                 Installed CLI binary + node_modules
#
# Wrapper: /usr/local/bin/ix (if writable) or ~/.local/bin/ix (fallback)
# Ports: 8090 (Memory Layer), 8529 (ArangoDB) — localhost only
```
