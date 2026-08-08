import { Command } from "commander";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, lstatSync, renameSync, readdirSync } from "fs";
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
    const parsed = JSON.parse(readFileSync(VERSION_CACHE, "utf-8"));
    // JSON.parse only proves it is JSON, not that it is *this* shape. A cache
    // file holding `{"latest": 123}` used to reach isNewer() and throw
    // "latest.split is not a function", which surfaced as a successful command
    // exiting 1. Every field that reaches isNewer() has to be checked, not just
    // `latest` — the optional two get there behind a bare truthiness test.
    const optionalString = (v: unknown) => v === undefined || typeof v === "string";
    if (
      typeof parsed?.latest !== "string" ||
      typeof parsed?.checkedAt !== "number" ||
      !optionalString(parsed.compassLatest) ||
      !optionalString(parsed.backendLatest)
    ) {
      return null;
    }
    return parsed as VersionCache;
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

/**
 * The compass version actually on disk.
 *
 * A `.version` stamp is only meaningful if the bundle it describes is really
 * there. Installers used to write the stamp without installing anything, which
 * made every version comparison below report "already current" and skip the
 * download that would have fixed it — `ix view` then failed permanently. Treat
 * a stamp with no `index.html` beside it as "not installed" so the repair path
 * always runs.
 */
function getInstalledCompassVersion(): string {
  if (!existsSync(join(COMPASS_DIR, "index.html"))) return "0.0.0";
  return getTrackedVersion(COMPASS_VERSION_FILE);
}

function getTrackedVersion(versionFile: string): string {
  try {
    if (!existsSync(versionFile)) return "0.0.0";
    return readFileSync(versionFile, "utf-8").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Extract a .zip on Windows, trying every extractor a Windows box might have.
 *
 * This used to call `unzip` alone, which is NOT present on stock Windows — it
 * only exists if the user happens to have Git Bash or MSYS. Combined with the
 * install directory being deleted before extraction, a missing `unzip` removed
 * the user's CLI and installed nothing in its place.
 *
 * Order matters: bsdtar ships with Windows 10 1803+ and reads zip archives, so
 * it is both the most likely to exist and the fastest. PowerShell is always
 * present. `unzip` stays last for MSYS shells where it may be the only one.
 */
function extractZipOnWindows(zipPath: string, destDir: string): void {
  const toUnixPath = (p: string): string => {
    try {
      return execFileSync("cygpath", ["-u", p], { encoding: "utf-8" }).trim();
    } catch {
      return p;
    }
  };

  // PowerShell single-quoted strings escape a quote by doubling it.
  const psQuote = (p: string): string => `'${p.replace(/'/g, "''")}'`;

  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "tar", args: ["-xf", zipPath, "-C", destDir] },
    {
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`,
      ],
    },
    { cmd: "unzip", args: ["-q", toUnixPath(zipPath), "-d", toUnixPath(destDir)] },
  ];

  const failures: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return;
    } catch (err) {
      failures.push(`${cmd}: ${(err as Error).message}`);
    }
  }
  throw new Error(`no usable zip extractor found (${failures.join("; ")})`);
}

/**
 * The single top-level directory an archive extracted into, if there is exactly
 * one. Windows release zips nest everything under `ix-<version>-<platform>/`,
 * and reading it back beats assuming the name — the shim has to point inside it.
 */
export function soleChildDir(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    return entries.length === 1 && entries[0] ? join(dir, entries[0].name) : null;
  } catch {
    return null;
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
    const compassCurrent = getInstalledCompassVersion();
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
    const compassCurrent = getInstalledCompassVersion();
    const hasCompassUpdate =
      compassLatest && isNewer(compassLatest, compassCurrent);
    const backendCurrent = getTrackedVersion(BACKEND_VERSION_FILE);
    const hasBackendUpdate =
      backendLatest && isNewer(backendLatest, backendCurrent);
    if (hasCliUpdate || hasCompassUpdate || hasBackendUpdate) {
      printUpdateNotice(current, latest, !!hasCompassUpdate, !!hasBackendUpdate);
    }
  }).catch(() => {
    // Best-effort background check: it must never affect the command the user
    // actually ran. Without this catch the floating promise would reach the
    // process-level unhandledRejection handler and abort an otherwise
    // successful command.
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

          // Extract into a staging directory beside the install, verify the
          // result actually runs, and only then swap it in. The previous order
          // was rmSync(installDir) *first*, so any extraction failure left the
          // user with no CLI at all — and on Windows that failure was the
          // default case, because the extractor it called (`unzip`) is not
          // present on a stock Windows box. Staging lives under IX_HOME rather
          // than the temp dir so the swap is a same-filesystem rename.
          const stagingDir = join(IX_HOME, `.cli-staging-${process.pid}`);
          const cleanupStaging = () => {
            rmSync(stagingDir, { recursive: true, force: true });
            rmSync(tmpDirRaw, { recursive: true, force: true });
          };

          try {
            rmSync(stagingDir, { recursive: true, force: true });
            mkdirSync(stagingDir, { recursive: true });
            if (isWindows) {
              extractZipOnWindows(tmpFile, stagingDir);
            } else {
              execFileSync(
                "tar",
                ["-xzf", tmpFile, "-C", stagingDir, "--strip-components=1"],
                { stdio: "ignore" }
              );
            }
          } catch (err) {
            console.error("[error] Failed to extract CLI update.");
            console.error(`  ${(err as Error).message}`);
            console.error("  Your existing install is untouched.");
            cleanupStaging();
            process.exit(1);
          }

          // Windows zips nest under ix-<version>-<platform>/; POSIX tarballs are
          // already flattened by --strip-components. Resolve either shape.
          const stagedRoot = isWindows ? (soleChildDir(stagingDir) ?? stagingDir) : stagingDir;
          const stagedEntry = join(stagedRoot, "cli", "dist", "cli", "main.js");
          if (!existsSync(stagedEntry)) {
            console.error("[error] Downloaded archive did not contain the expected CLI entry point.");
            console.error(`  Expected: ${stagedEntry}`);
            console.error("  Your existing install is untouched.");
            cleanupStaging();
            process.exit(1);
          }

          // Move the old install aside rather than deleting it outright, so a
          // failure part-way through the swap can put it back instead of
          // leaving the user with nothing.
          const backupDir = join(IX_HOME, `.cli-backup-${process.pid}`);
          try {
            rmSync(backupDir, { recursive: true, force: true });
            if (existsSync(installDir)) renameSync(installDir, backupDir);
            renameSync(stagingDir, installDir);
            rmSync(backupDir, { recursive: true, force: true });
            rmSync(tmpDirRaw, { recursive: true, force: true });
          } catch (err) {
            console.error("[error] Failed to install the CLI update.");
            console.error(`  ${(err as Error).message}`);
            // Put the previous install back if the swap left it moved aside.
            try {
              if (existsSync(backupDir) && !existsSync(installDir)) {
                renameSync(backupDir, installDir);
                console.error("  Restored your previous install.");
              }
            } catch { /* nothing further we can do */ }
            cleanupStaging();
            process.exit(1);
          }

          // Repoint the launcher at the new install. Both shim shapes have to be
          // handled: install.ps1 writes %IX_HOME%\bin\ix.cmd containing a
          // *version-encoded* path into ~/.ix/cli, while install.sh (Git Bash)
          // writes a bash shim to ~/.local/bin/ix. Only the latter was ever
          // refreshed, so a PowerShell-installed user was left with a launcher
          // pointing into the version directory this upgrade had just deleted.
          if (isWindows) {
            const installedRoot = soleChildDir(installDir) ?? installDir;
            const entryWin = join(installedRoot, "cli", "dist", "cli", "main.js");

            // The .cmd launcher install.ps1 puts on PATH.
            try {
              const cmdShim = join(IX_HOME, "bin", "ix.cmd");
              mkdirSync(dirname(cmdShim), { recursive: true });
              writeFileSync(cmdShim, `@echo off\r\nnode "${entryWin}" %*\r\n`, "ascii");
            } catch { /* shim refresh is best-effort */ }

            // The bash shim install.sh puts on PATH under Git Bash / MSYS.
            const shimPath = join(homedir(), ".local", "bin", "ix");
            let jsPath = entryWin;
            try {
              jsPath = execFileSync("cygpath", ["-u", entryWin], { encoding: "utf-8" }).trim();
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
      const compassCurrent = getInstalledCompassVersion();
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
