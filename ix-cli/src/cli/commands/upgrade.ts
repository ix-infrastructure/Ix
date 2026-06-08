import { Command } from "commander";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, lstatSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import chalk from "chalk";
import { BACKEND_IMAGE, checkBackendImage, isNonStandardBackend } from "../backend-status.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GITHUB_ORG = "ix-infrastructure";
const GITHUB_REPO = "Ix";
const COMPASS_DIST_REPO = "ix-compass-dist";
const MEMORY_LAYER_DIST_REPO = "ix-memory-layer-dist";
const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const VERSION_CACHE = join(IX_HOME, ".version-check.json");
const COMPASS_DIR = join(IX_HOME, "cli", "compass");
const COMPASS_VERSION_FILE = join(COMPASS_DIR, ".version");
const BACKEND_VERSION_FILE = join(IX_HOME, ".backend-version");

interface VersionCache {
  latest: string;
  compassLatest?: string;
  backendLatest?: string;
  checkedAt: number;
}

function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../../package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Strict semver (X.Y.Z with optional -prerelease/+build). The release tag comes
// from the network and later flows into file paths, the install shim, and
// download URLs, so it is validated here at the source: anything that isn't a
// plain version is rejected (CodeQL js/http-to-file-access barrier + general
// hardening against a tampered/unexpected tag).
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

async function fetchLatestRelease(repo: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_ORG}/${repo}/releases/latest`
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { tag_name?: string };
    const version = data.tag_name?.replace(/^v/, "") ?? null;
    if (version === null || !VERSION_RE.test(version)) return null;
    return version;
  } catch {
    return null;
  }
}

function readCache(): VersionCache | null {
  try {
    if (!existsSync(VERSION_CACHE)) return null;
    return JSON.parse(readFileSync(VERSION_CACHE, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(latest: string, compassLatest?: string, backendLatest?: string): void {
  try {
    mkdirSync(IX_HOME, { recursive: true });
    const data: VersionCache = { latest, checkedAt: Date.now() };
    if (compassLatest) data.compassLatest = compassLatest;
    if (backendLatest) data.backendLatest = backendLatest;
    writeFileSync(VERSION_CACHE, JSON.stringify(data));
  } catch {
    // non-critical
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function getTrackedVersion(versionFile: string): string {
  try {
    if (!existsSync(versionFile)) return "0.0.0";
    return readFileSync(versionFile, "utf-8").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function detectPlatform(): string {
  let os: string;
  if (process.platform === "darwin") os = "darwin";
  else if (process.platform === "win32") os = "windows";
  else os = "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}

/**
 * Check for updates (non-blocking, cached for 1 hour).
 * Call this from other commands to notify users.
 */
export async function checkForUpdate(): Promise<void> {
  const current = getCurrentVersion();
  const cache = readCache();

  if (cache && Date.now() - cache.checkedAt < 3600_000) {
    const hasCliUpdate = isNewer(cache.latest, current);
    const compassCurrent = getTrackedVersion(COMPASS_VERSION_FILE);
    const hasCompassUpdate =
      cache.compassLatest && isNewer(cache.compassLatest, compassCurrent);
    const backendCurrent = getTrackedVersion(BACKEND_VERSION_FILE);
    const hasBackendUpdate =
      cache.backendLatest && isNewer(cache.backendLatest, backendCurrent);
    if (hasCliUpdate || hasCompassUpdate || hasBackendUpdate) {
      printUpdateNotice(current, cache.latest, !!hasCompassUpdate, !!hasBackendUpdate);
    }
    return;
  }

  Promise.all([
    fetchLatestRelease(GITHUB_REPO),
    fetchLatestRelease(COMPASS_DIST_REPO),
    fetchLatestRelease(MEMORY_LAYER_DIST_REPO),
  ]).then(([latest, compassLatest, backendLatest]) => {
    if (!latest) return;
    writeCache(latest, compassLatest ?? undefined, backendLatest ?? undefined);
    const hasCliUpdate = isNewer(latest, current);
    const compassCurrent = getTrackedVersion(COMPASS_VERSION_FILE);
    const hasCompassUpdate =
      compassLatest && isNewer(compassLatest, compassCurrent);
    const backendCurrent = getTrackedVersion(BACKEND_VERSION_FILE);
    const hasBackendUpdate =
      backendLatest && isNewer(backendLatest, backendCurrent);
    if (hasCliUpdate || hasCompassUpdate || hasBackendUpdate) {
      printUpdateNotice(current, latest, !!hasCompassUpdate, !!hasBackendUpdate);
    }
  });
}

function printUpdateNotice(
  current: string,
  latest: string,
  compassUpdate?: boolean,
  backendUpdate?: boolean
): void {
  process.stderr.write("\r" + " ".repeat(80) + "\r");
  console.error("");
  if (isNewer(latest, current)) {
    console.error(chalk.yellow(`  Update available: ${current} → ${latest}`));
  }
  if (compassUpdate) {
    console.error(chalk.yellow("  Compass update available"));
  }
  if (backendUpdate) {
    console.error(chalk.yellow("  Backend update available"));
  }
  console.error(chalk.dim("  Run: ix upgrade"));
  console.error("");
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade ix CLI, backend, and components to the latest version")
    .option("--check", "Only check for updates, don't install")
    .action(async (opts: { check?: boolean }) => {
      const current = getCurrentVersion();
      console.log(`Current version: ${current}`);
      console.log("Checking for updates...");

      const [latest, compassLatest, backendLatest] = await Promise.all([
        fetchLatestRelease(GITHUB_REPO),
        fetchLatestRelease(COMPASS_DIST_REPO),
        fetchLatestRelease(MEMORY_LAYER_DIST_REPO),
      ]);

      if (!latest) {
        console.error("[error] Could not reach GitHub to check for updates.");
        process.exit(1);
      }

      // ── CLI upgrade ──────────────────────────────────────────────────
      const cliUpToDate = !isNewer(latest, current);
      if (cliUpToDate) {
        console.log(`[ok] CLI already on the latest version (${current})`);
      } else {
        console.log(`New CLI version available: ${chalk.green(latest)}`);

        if (!opts.check) {
          const platform = detectPlatform();
          const isWindows = platform.startsWith("windows");
          const archiveName = isWindows
            ? `ix-${latest}-${platform}.zip`
            : `ix-${latest}-${platform}.tar.gz`;
          const url = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${latest}/${archiveName}`;
          const installDir = join(IX_HOME, "cli");

          const tmpDirRaw = mkdtempSync(join(tmpdir(), "ix-upgrade-"));
          const tmpFile = join(tmpDirRaw, archiveName);

          console.log(`Downloading ix ${latest} for ${platform}...`);

          try {
            execFileSync(
              "curl",
              ["-fsSL", "--progress-bar", url, "-o", tmpFile],
              { stdio: ["ignore", "inherit", "inherit"], timeout: 300000 }
            );
          } catch {
            console.error(`[error] Failed to download ${url}`);
            console.error("  You can also upgrade manually:");
            console.error(
              `  curl -fsSL https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main/scripts/install/install.sh | bash`
            );
            rmSync(tmpDirRaw, { recursive: true, force: true });
            process.exit(1);
          }

          console.log("Installing...");
          try {
            rmSync(installDir, { recursive: true, force: true });
            mkdirSync(installDir, { recursive: true });
            if (isWindows) {
              let unixTmpFile = tmpFile;
              let unixInstallDir = installDir;
              try {
                unixTmpFile = execFileSync("cygpath", ["-u", tmpFile], { encoding: "utf-8" }).trim();
                unixInstallDir = execFileSync("cygpath", ["-u", installDir], { encoding: "utf-8" }).trim();
              } catch { /* use as-is */ }
              execFileSync("unzip", ["-q", unixTmpFile, "-d", unixInstallDir], { stdio: "ignore" });
            } else {
              execFileSync(
                "tar",
                ["-xzf", tmpFile, "-C", installDir, "--strip-components=1"],
                { stdio: "ignore" }
              );
            }
            rmSync(tmpDirRaw, { recursive: true, force: true });
          } catch {
            console.error("[error] Failed to extract CLI update.");
            rmSync(tmpDirRaw, { recursive: true, force: true });
            process.exit(1);
          }

          // On Windows, update the shim to point to the new versioned directory
          if (isWindows) {
            const shimPath = join(homedir(), ".local", "bin", "ix");
            const jsPathWin = join(installDir, `ix-${latest}-${platform}`, "cli", "dist", "cli", "main.js");
            let jsPath = jsPathWin;
            try {
              jsPath = execFileSync("cygpath", ["-u", jsPathWin], { encoding: "utf-8" }).trim();
            } catch { /* use windows path */ }
            // Write the shim directly (creating ~/.local/bin if needed) rather than
            // existsSync-then-write, which is a TOCTOU (CodeQL js/file-system-race).
            // jsPath derives only from the validated-semver `latest` + install dir.
            try {
              mkdirSync(dirname(shimPath), { recursive: true });
              writeFileSync(shimPath, `#!/usr/bin/env bash\nexec node "${jsPath}" "$@"\n`);
            } catch { /* shim refresh is best-effort */ }
          }

          console.log(`[ok] Upgraded ix: ${current} → ${latest}`);
        }
      }

      // ── Pro plugin refresh (entitlement-gated, OSS-safe) ─────────────
      // @ix/pro is an optional private plugin installed OUTSIDE ~/.ix/cli, at
      // ~/.ix/node_modules, so it survives the wholesale rmSync(~/.ix/cli) above
      // (KNOWN_ISSUES #27). Runs regardless of whether the CLI itself updated, so
      // a single `ix upgrade` keeps both in sync. Behaviour by install shape:
      //   - real install present  -> npm update it (tracks CLI releases)
      //   - dev symlink present    -> leave it (the dev rebuilds their own repo)
      //   - absent (OSS users)     -> do nothing, print nothing; Pro stays invisible
      if (!opts.check) {
        const proDir = join(IX_HOME, "node_modules", "@ix", "pro");
        let proPresent = false;
        let proIsLink = false;
        try {
          proPresent = existsSync(proDir);
          proIsLink = proPresent && lstatSync(proDir).isSymbolicLink();
        } catch { /* treat as absent */ }
        if (proPresent && !proIsLink) {
          try {
            console.log("Refreshing @ix/pro...");
            execFileSync("npm", ["update", "--prefix", IX_HOME, "@ix/pro"], {
              stdio: "ignore",
              timeout: 120000,
            });
            console.log("[ok] @ix/pro refreshed");
          } catch {
            console.error("[!!] Could not refresh @ix/pro. Run: npm update --prefix ~/.ix @ix/pro");
          }
        }
      }

      // ── Backend (memory-layer) upgrade ───────────────────────────────
      const backendCurrent = getTrackedVersion(BACKEND_VERSION_FILE);
      let backendImageChanged = false;
      if (backendLatest && isNewer(backendLatest, backendCurrent)) {
        console.log(
          `Backend update available: ${backendCurrent === "0.0.0" ? "none" : backendCurrent} → ${chalk.green(backendLatest)}`
        );

        if (!opts.check) {
          console.log("Pulling latest backend image...");
          try {
            execFileSync(
              "docker",
              ["pull", "ghcr.io/ix-infrastructure/ix-memory-layer:latest"],
              { stdio: "inherit", timeout: 120000 }
            );
            mkdirSync(IX_HOME, { recursive: true });
            writeFileSync(BACKEND_VERSION_FILE, backendLatest);
            backendImageChanged = true;
            console.log(`[ok] Backend image updated to ${backendLatest}`);
          } catch {
            console.error("[!!] Could not pull latest backend image. Run: ix docker restart");
          }

          // Restart backend if running
          try {
            execFileSync("curl", ["-sf", "http://localhost:8090/v1/health"], {
              stdio: "ignore",
              timeout: 3000,
            });
            console.log("Restarting backend...");
            const composeFile = join(IX_HOME, "backend", "docker-compose.yml");
            if (existsSync(composeFile)) {
              execFileSync(
                "docker",
                ["compose", "-f", composeFile, "up", "-d", "--pull", "always"],
                { stdio: "inherit" }
              );
              console.log("[ok] Backend restarted with latest image");
            }
          } catch {
            // Backend not running, that's fine
          }
        }
      } else if (backendLatest) {
        console.log(`[ok] Backend already on the latest version (${backendCurrent})`);
      } else {
        console.log("[--] Could not check backend version");
      }

      // ── Backend running-image verification (Ix#270) ──────────────────
      // The version stamp above only reflects what was last pulled, not what is
      // actually running. Inspect the live container so a stale local/dev image
      // is surfaced even when the stamp reads current.
      if (!opts.check) {
        const imageStatus = checkBackendImage();
        if (imageStatus.kind === "local-build") {
          console.log(
            chalk.yellow(
              `[!!] Backend container is a local build (${imageStatus.container.imageRef}), not the released image.`
            )
          );
          console.log(chalk.dim("     Run: ix docker stop && ix docker start  (pulls " + BACKEND_IMAGE + ":latest)"));
        } else if (imageStatus.kind === "digest-mismatch") {
          console.log(chalk.yellow("[!!] Backend container is running an older image digest than :latest."));
          console.log(chalk.dim("     Run: ix docker stop && ix docker start  (pulls the released image)"));
        } else if (imageStatus.kind === "ok" && isNonStandardBackend(imageStatus.container)) {
          console.log(
            chalk.yellow(
              `[!!] Backend is served by a non-standard compose project (${imageStatus.container.composeProject ?? "unknown"}), not ~/.ix/backend.`
            )
          );
        }
      }

      // ── Re-map prompt after a backend update (Ix#271) ────────────────
      // A graph written by the previous engine may lack fields the new read
      // paths filter on (workspace_id/system_id), so scoped reads return empty
      // until the user re-maps. Nudge them once, right after the image changes.
      if (backendImageChanged) {
        console.log("");
        console.log(chalk.yellow("  Backend engine updated. Re-map your repositories so the graph matches:"));
        console.log(chalk.dim("    ix map ."));
      }

      // ── Compass upgrade ──────────────────────────────────────────────
      const compassCurrent = getTrackedVersion(COMPASS_VERSION_FILE);
      if (compassLatest && isNewer(compassLatest, compassCurrent)) {
        console.log(
          `Compass update available: ${compassCurrent === "0.0.0" ? "none" : compassCurrent} → ${chalk.green(compassLatest)}`
        );

        if (!opts.check) {
          const compassUrl = `https://github.com/${GITHUB_ORG}/${COMPASS_DIST_REPO}/releases/download/v${compassLatest}/compass-${compassLatest}.tar.gz`;
          const compassTmp = mkdtempSync(join(tmpdir(), "ix-compass-"));
          const compassTar = join(compassTmp, `compass-${compassLatest}.tar.gz`);

          try {
            execFileSync("curl", ["-fsSL", compassUrl, "-o", compassTar], {
              stdio: ["ignore", "inherit", "inherit"],
              timeout: 60000,
            });
            mkdirSync(COMPASS_DIR, { recursive: true });
            rmSync(COMPASS_DIR, { recursive: true, force: true });
            mkdirSync(COMPASS_DIR, { recursive: true });
            let tarFile = compassTar;
            let tarDest = COMPASS_DIR;
            if (process.platform === "win32") {
              try {
                tarFile = execFileSync("cygpath", ["-u", compassTar], { encoding: "utf-8" }).trim();
                tarDest = execFileSync("cygpath", ["-u", COMPASS_DIR], { encoding: "utf-8" }).trim();
              } catch { /* use as-is */ }
            }
            execFileSync(
              "tar",
              ["-xzf", tarFile, "-C", tarDest, "--strip-components=1"],
              { stdio: "ignore" }
            );
            writeFileSync(COMPASS_VERSION_FILE, compassLatest);
            console.log(`[ok] Compass upgraded to ${compassLatest}`);
          } catch {
            console.error("[!!] Could not download compass update. ix view may use the bundled version.");
          }
          rmSync(compassTmp, { recursive: true, force: true });
        }
      } else if (compassLatest) {
        console.log(`[ok] Compass already on the latest version (${compassCurrent})`);
      } else {
        console.log("[--] Could not check compass version");
      }

      // ── Update cache with all latest versions ────────────────────────
      writeCache(latest, compassLatest ?? undefined, backendLatest ?? undefined);

      console.log("");
      console.log("[ok] ix is up to date");
    });
}
