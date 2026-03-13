# Install & Distribution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create cross-platform install scripts (curl/PowerShell/CMD) and update Homebrew formula so users can install Ix with one command, no Docker required.

**Architecture:** Install scripts download platform-specific archives from GitHub Releases containing the CLI, fat JAR, and bundled JRE. Homebrew formula updated to use the same archive approach.

**Tech Stack:** Shell (POSIX sh), PowerShell, GitHub Actions, sbt assembly, Homebrew Ruby DSL

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `install.sh` | macOS/Linux/WSL installer — platform detection, download, verify, install |
| `install.ps1` | Windows PowerShell installer |
| `install.cmd` | Windows CMD wrapper for PowerShell |
| `.github/workflows/release.yml` | CI pipeline to build platform archives and create GitHub releases |
| `scripts/package.sh` | Local script to build a platform archive for testing |

### Modified Files

| File | Change |
|------|--------|
| `homebrew/ix.rb` | Rewrite formula — archive-based instead of npm build |
| `scripts/release.sh` | Update for new release flow |
| `ix-cli/src/cli/config.ts` | Add XDG path resolution functions |

---

## Chunk 1: Packaging

### Task 1: Create package.sh for building platform archives

**Files:**
- Create: `scripts/package.sh`

- [ ] **Step 1: Write the packaging script**

```bash
#!/bin/sh
set -eu

# Build a platform archive for the current platform
VERSION="${1:-dev}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported: $(uname -m)"; exit 1 ;;
esac

PLATFORM="${OS}-${ARCH}"
DIST_DIR="dist/ix-${VERSION}-${PLATFORM}"

echo "Building ix ${VERSION} for ${PLATFORM}..."

# 1. Build fat JAR
echo "Building server JAR..."
sbt "memoryLayer/assembly"

# 2. Build CLI
echo "Building CLI..."
cd ix-cli && npm run build && cd ..

# 3. Create dist directory
rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}/server"

# 4. Copy artifacts
cp memory-layer/target/scala-2.13/ix-memory-layer.jar "${DIST_DIR}/server/"
cp -r ix-cli/dist "${DIST_DIR}/cli"
cp ix-cli/package.json "${DIST_DIR}/cli/"

# 5. Create ix wrapper script
cat > "${DIST_DIR}/ix" << 'WRAPPER'
#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/cli/dist/cli/main.js" "$@"
WRAPPER
chmod +x "${DIST_DIR}/ix"

# 6. Create archive
echo "Creating archive..."
cd dist
tar czf "ix-${VERSION}-${PLATFORM}.tar.gz" "ix-${VERSION}-${PLATFORM}"
shasum -a 256 "ix-${VERSION}-${PLATFORM}.tar.gz" > "ix-${VERSION}-${PLATFORM}.tar.gz.sha256"
cd ..

echo "Done: dist/ix-${VERSION}-${PLATFORM}.tar.gz"
```

- [ ] **Step 2: Make executable and test**

Run: `chmod +x scripts/package.sh && ./scripts/package.sh 0.2.0`
Expected: Creates `dist/ix-0.2.0-darwin-arm64.tar.gz` (or equivalent)

- [ ] **Step 3: Commit**

```bash
git add scripts/package.sh
git commit -m "build: add package.sh for creating platform archives"
```

---

### Task 2: Create install.sh

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Write the install script**

POSIX sh, `set -eu`, no bash-isms. Must:
1. Detect OS (Darwin/Linux) and arch (arm64/amd64)
2. Determine install dirs: `IX_INSTALL_DIR` (default `~/.local/share/ix`), bin dir (`~/.local/bin`)
3. Fetch manifest.json from GitHub Releases (or latest release API)
4. Download platform archive
5. Verify SHA-256 checksum
6. Extract to install dir
7. Create symlink `~/.local/bin/ix` → install dir ix wrapper
8. Add `~/.local/bin` to PATH in `.bashrc`/`.zshrc` if not present
9. Write local manifest.json
10. Run `ix --version` to verify
11. Print success message

Support flags: `--no-modify-path`, `--version VERSION`, `--channel CHANNEL`

- [ ] **Step 2: Test the install script locally**

Run: `sh install.sh --version 0.2.0` (with a test archive)
Expected: Installs to `~/.local/share/ix/`, creates `~/.local/bin/ix` symlink

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: add cross-platform install.sh for macOS/Linux/WSL"
```

---

### Task 3: Create install.ps1 and install.cmd

**Files:**
- Create: `install.ps1`
- Create: `install.cmd`

- [ ] **Step 1: Write install.ps1**

PowerShell equivalent of install.sh:
1. Detect arch (x64/arm64)
2. Download from GitHub Releases
3. Verify checksum
4. Extract to `$env:LOCALAPPDATA\ix\`
5. Add to user PATH
6. Write local manifest

- [ ] **Step 2: Write install.cmd**

Thin wrapper:
```cmd
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/ORG/IX-Memory/main/install.ps1'))"
```

- [ ] **Step 3: Commit**

```bash
git add install.ps1 install.cmd
git commit -m "feat: add Windows install scripts (PowerShell + CMD)"
```

---

## Chunk 2: Homebrew + XDG Config

### Task 4: Update Homebrew formula

**Files:**
- Modify: `homebrew/ix.rb`

- [ ] **Step 1: Rewrite formula**

The formula should:
- Download platform archive from GitHub Releases (using `Hardware::CPU.arm?` etc for platform detection)
- Extract to `libexec/`
- Create bin symlink
- Include node as a dependency (for CLI)
- Test block: `system "#{bin}/ix", "--version"`

- [ ] **Step 2: Commit**

```bash
git add homebrew/ix.rb
git commit -m "feat: update Homebrew formula for archive-based install"
```

---

### Task 5: Add XDG path helpers to CLI config

**Files:**
- Modify: `ix-cli/src/cli/config.ts`

- [ ] **Step 1: Add XDG-aware path resolution**

Add functions that resolve paths per platform:
- `getDataDir()` → `~/.local/share/ix` (Linux/macOS) or `%LOCALAPPDATA%\ix\data` (Windows)
- `getConfigDir()` → `~/.config/ix` (Linux/macOS) or `%APPDATA%\ix` (Windows)
- `getStateDir()` → `~/.local/state/ix` (Linux/macOS) or `%LOCALAPPDATA%\ix\state` (Windows)
- `getCacheDir()` → `~/.cache/ix` (Linux/macOS) or `%LOCALAPPDATA%\ix\cache` (Windows)
- All respect `IX_DATA_DIR`, `IX_CONFIG_DIR` overrides and XDG env vars

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/config.ts
git commit -m "feat: add XDG-compliant path resolution to CLI config"
```

---

## Chunk 3: CI Release Pipeline

### Task 6: Create GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

Triggers on tag `v*`. Build matrix for 6 platforms. For each:
1. Build fat JAR (sbt assembly — only once, shared across platforms)
2. Build CLI (npm run build)
3. Download platform JRE (Adoptium Temurin 21)
4. Package archive
5. Compute SHA-256
6. Generate manifest.json
7. Create GitHub Release with all archives + manifest

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add multi-platform release workflow"
```

---

### Task 7: Update release.sh

**Files:**
- Modify: `scripts/release.sh`

- [ ] **Step 1: Update for new flow**

1. Bump version in build.sbt + package.json
2. Commit + tag
3. Push (triggers CI workflow)
4. Print instructions

- [ ] **Step 2: Commit**

```bash
git add scripts/release.sh
git commit -m "build: update release.sh for CI-driven releases"
```
