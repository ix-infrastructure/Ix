import { Command } from "commander";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, lstatSync, renameSync, readdirSync } from "fs";
import { basename, dirname, join } from "path";
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
// The pre-release and build parts are separate optional groups. Written as one
// `(?:[-+]...)?` group, the character class had no `+`, so a tag carrying both
// — `0.9.0-rc.1+abc1234`, valid semver — failed the test. fetchLatestRelease
// then returned null and `ix upgrade` reported "Could not reach GitHub to check
// for updates" and exited 1 against a perfectly reachable GitHub.
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

/**
 * Split a version into its numeric release triple and its pre-release
 * identifiers. `0.9.0-rc.1` -> `[[0,9,0], ["rc","1"]]`.
 */
function splitVersion(v: string): [number[], string[]] {
  // Build metadata (`+sha`) never participates in precedence.
  const withoutBuild = v.split("+")[0]!;
  // Split at the FIRST hyphen and keep everything after it. `split("-", 2)`
  // looks right and is not: the limit truncates rather than capturing the
  // remainder, so `0.9.0-rc-1` would yield pre-release "rc" and drop the "-1"
  // — making 0.9.0-rc-1 and 0.9.0-rc-2 compare equal, which is the same
  // stranded-on-a-candidate bug this function exists to fix.
  const hyphen = withoutBuild.indexOf("-");
  const core = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen);
  const pre = hyphen === -1 ? "" : withoutBuild.slice(hyphen + 1);
  const nums = core.split(".").map((n) => {
    const parsed = Number(n);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return [nums, pre ? pre.split(".") : []];
}

/**
 * Is `latest` a higher version than `current`?
 *
 * The old implementation was `split(".").map(Number)`, which turns
 * `0.9.0-rc.1` into `[0, 9, NaN, 1]`. Every NaN compared false and was then
 * coerced to 0 by `(l[i] || 0)`, so `isNewer("0.9.0", "0.9.0-rc.1")` returned
 * false: anyone running a release candidate was never told the GA shipped, and
 * `ix upgrade` reported them already current. `0.9.0-rc.2` over `0.9.0-rc.1`
 * failed the same way, so candidates could not even be updated to each other.
 *
 * Follows semver precedence: compare the release triple numerically; a version
 * with no pre-release outranks one that has it; otherwise compare pre-release
 * identifiers left to right, numeric ones numerically and below alphanumeric
 * ones, and a longer identifier list wins when all preceding fields are equal.
 */
export function isNewer(latest: string, current: string): boolean {
  const [lNums, lPre] = splitVersion(latest);
  const [cNums, cPre] = splitVersion(current);

  for (let i = 0; i < 3; i++) {
    const a = lNums[i] ?? 0;
    const b = cNums[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }

  // Same release triple. A release outranks any pre-release of itself.
  if (lPre.length === 0 && cPre.length === 0) return false;
  if (lPre.length === 0) return true;
  if (cPre.length === 0) return false;

  for (let i = 0; i < Math.max(lPre.length, cPre.length); i++) {
    const a = lPre[i];
    const b = cPre[i];
    if (a === undefined) return false; // shorter list is lower
    if (b === undefined) return true;
    if (a === b) continue;

    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) {
      // Only return once the comparison is actually decided. Two identifiers
      // can differ as text but not as numbers (`01` vs `1`), and returning
      // here would end the whole comparison as "not newer" instead of moving
      // on to the next identifier.
      const na = Number(a);
      const nb = Number(b);
      if (na !== nb) return na > nb;
      continue;
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNum !== bNum) return bNum;
    return a > b;
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
 * Render a failed `execFileSync` as something a user can act on.
 *
 * Two shapes matter. A missing binary throws `ENOENT` with a message that names
 * the spawn but not the cause, so the fix — put it on PATH — has to be spelled
 * out. A binary that ran and exited non-zero puts the real explanation on
 * stderr, which is lost unless the caller piped it and reads it back here.
 */
export function describeExecFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
  // ENOENT on its own does not mean "no such binary" — every filesystem miss
  // carries it too (`ENOENT: ... open '...\.version'`, syscall "open"). Only a
  // spawn failure is a PATH problem, and advising someone to put their version
  // file on PATH sends them nowhere. The syscall is what separates the two.
  if (e.code === "ENOENT" && e.syscall?.startsWith("spawn")) {
    return `${e.message} — is it installed and on PATH?`;
  }
  // execFileSync folds piped stderr into `message` already, so appending it
  // unconditionally printed the command's entire complaint twice. Only reach
  // for `.stderr` when the message did not already carry it.
  const stderr = e.stderr?.toString().trim();
  return stderr && !e.message.includes(stderr) ? `${e.message}: ${stderr}` : e.message;
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
        // $ErrorActionPreference is load-bearing. Expand-Archive reports
        // unreadable entries and per-file access denials as *non-terminating*
        // errors, and powershell.exe still exits 0 for those — so without this
        // a half-extracted tree reads as success and the fallback below is
        // never tried.
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipPath)} ` +
          `-DestinationPath ${psQuote(destDir)} -Force`,
      ],
    },
    { cmd: "unzip", args: ["-q", "-o", toUnixPath(zipPath), "-d", toUnixPath(destDir)] },
  ];

  const failures: string[] = [];
  for (const { cmd, args } of attempts) {
    // Start each attempt from an empty destination. A previous extractor may
    // have left a partial tree behind, and merging a second attempt into it
    // would produce a directory that looks complete and is not.
    rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    mkdirSync(destDir, { recursive: true });
    try {
      // Capture stderr rather than discarding it: the aggregated message below
      // is the only diagnostic the user ever sees, and "Command failed:
      // powershell ..." on its own is unactionable.
      execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string };
      const detail = e.stderr ? String(e.stderr).trim() : "";
      failures.push(`${cmd}: ${detail || e.message}`);
      continue;
    }
    // An extractor that exits 0 without producing anything has not succeeded.
    if (readdirSync(destDir).length === 0) {
      failures.push(`${cmd}: exited 0 but extracted nothing`);
      continue;
    }
    return;
  }
  throw new Error(`no usable zip extractor found (${failures.join("; ")})`);
}

/**
 * Delete a directory without letting the failure escape.
 *
 * Used only for housekeeping — staging leftovers and the previous install once
 * the swap has already succeeded. On Windows `rmSync` defaults to no retries
 * and an AV or indexer handle on a tree the process was running from moments
 * ago is enough to throw, so the retries matter and the failure must not.
 */
function rmQuiet(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a leftover directory is reclaimed by sweepUpgradeOrphans on the next run */
  }
}

/**
 * The single top-level directory an archive extracted into, if there is exactly
 * one. Windows release zips nest everything under `ix-<version>-<platform>/`,
 * and reading it back beats assuming the name — the shim has to point inside it.
 */
export function soleChildDir(dir: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that is not there genuinely has no sole child. Anything else
    // — EACCES from a group-policy ACL, EMFILE — is a fault on this machine,
    // and swallowing it would surface downstream as "the release archive is
    // malformed", pointing the user at the wrong thing entirely.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  return dirs.length === 1 && dirs[0] ? join(dir, dirs[0].name) : null;
}

/**
 * Characters we are willing to interpolate into a launcher script.
 *
 * The version directory is read back out of the downloaded archive rather than
 * derived from the VERSION_RE-validated tag, so it has not been through that
 * barrier. `cmd.exe` splits a batch line on `&` and expands `%VAR%`, so a
 * directory name carrying either would change what the launcher runs.
 */
const SAFE_DIR_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Replace `installDir` with the tree staged in `stagingDir`.
 *
 * Cleanup of the previous install deliberately sits *outside* the failure
 * boundary. Once the second rename returns, the upgrade has happened; deleting
 * the old tree is housekeeping, and on Windows it is the single step most
 * likely to fail. Letting that failure propagate would abort the caller before
 * it repoints the launcher shims, leaving them aimed at a directory that no
 * longer exists — precisely the brick this path exists to prevent.
 *
 * Throws only when the install is still intact (or has been put back).
 */
export function swapInStagedTree(installDir: string, stagingDir: string, backupDir: string): void {
  rmQuiet(backupDir);
  if (existsSync(installDir)) renameSync(installDir, backupDir);
  try {
    renameSync(stagingDir, installDir);
  } catch (err) {
    try {
      if (existsSync(backupDir) && !existsSync(installDir)) renameSync(backupDir, installDir);
    } catch {
      /* caller reports where the surviving copy is */
    }
    throw err;
  }
  rmQuiet(backupDir);
}

/**
 * The staged tree to install, given the directory an archive extracted into.
 *
 * Windows zips nest everything under `ix-<version>-<platform>/`; POSIX tarballs
 * are already flattened by `--strip-components`. Resolve either shape.
 */
export function resolveStagedRoot(stagingDir: string, isWindows: boolean): string {
  return isWindows ? (soleChildDir(stagingDir) ?? stagingDir) : stagingDir;
}

/**
 * Install the tree staged in `stagingDir` at `installDir`.
 *
 * The choice of *which* directory to swap in lives here rather than at the call
 * site, because that choice was the bug. The upgrade path resolved the staged
 * root to read the CLI entry point out of it, then handed `swapInStagedTree`
 * the *outer* staging directory — reproducing inside `cli\` exactly the nesting
 * it had just seen through. COMPASS_DIR and findCompassDist read `cli\compass`
 * and nothing else, so `ix view` broke.
 *
 * Keeping the composition in one function is what makes it testable. A test
 * that resolves the staged root itself and then calls `swapInStagedTree`
 * directly passes just as happily against the bug as against the fix, because
 * the defect was never in either helper — it was in the line that joined them.
 */
export function installStagedTree(
  installDir: string,
  stagingDir: string,
  backupDir: string,
  isWindows: boolean
): void {
  swapInStagedTree(installDir, resolveStagedRoot(stagingDir, isWindows), backupDir);
  // The staged root moved out from under stagingDir, so on Windows the outer
  // directory survives the swap as an empty husk. Before the fix the swap
  // consumed it whole and there was nothing left to clear.
  rmQuiet(stagingDir);
}

/**
 * Replace the installed compass with the bundle in `tarPath`.
 *
 * Unpack beside the live copy and swap, rather than emptying `compassDir` and
 * extracting into the hole. The old order deleted the working compass first, so
 * a tar that failed — the exact failure the caller now bothers to report — left
 * no compass at all and `ix view` broken. That cost nothing while the Windows
 * bundle sat unreachable at `cli\ix-<version>-<platform>\compass`, but
 * install.ps1 now puts it exactly here, so the repair path would destroy the
 * copy the install just got right.
 *
 * `stagingDir` and `backupDir` belong under IX_HOME so the swap is a
 * same-filesystem rename; the OS temp dir can be on another volume.
 *
 * Throws with the working compass still in place.
 */
export function installCompassBundle(
  tarPath: string,
  compassDir: string,
  stagingDir: string,
  backupDir: string
): void {
  rmQuiet(stagingDir);
  mkdirSync(stagingDir, { recursive: true });

  let tarFile = tarPath;
  let tarDest = stagingDir;
  if (process.platform === "win32") {
    try {
      tarFile = execFileSync("cygpath", ["-u", tarPath], { encoding: "utf-8" }).trim();
      tarDest = execFileSync("cygpath", ["-u", stagingDir], { encoding: "utf-8" }).trim();
    } catch { /* use as-is */ }
  }
  execFileSync(
    "tar",
    ["-xzf", tarFile, "-C", tarDest, "--strip-components=1"],
    // Capture stderr rather than discarding it: this is the step that failed on
    // Windows and it left nothing behind to diagnose.
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  // An extract that "succeeded" without producing index.html is not a compass.
  // Swapping it in would replace a working bundle with one findCompassDist
  // rejects, and the caller's version stamp would then tell `ix upgrade` never
  // to try again — the poisoned-stamp failure both installers now avoid.
  if (!existsSync(join(stagingDir, "index.html"))) {
    throw new Error(`archive did not contain index.html (extracted to ${stagingDir})`);
  }

  // compassDir's parent is the install dir. It exists in every real install,
  // but not necessarily in a dev tree that only sets IX_HOME.
  mkdirSync(dirname(compassDir), { recursive: true });
  swapInStagedTree(compassDir, stagingDir, backupDir);
}

/**
 * Clear the scratch directories a compass swap used.
 *
 * `backupDir` goes only once the compass is actually back in place. If the swap
 * tore — the old bundle moved aside, the new one failed to land, and
 * swapInStagedTree's own restore failed too — then the backup holds the only
 * copy of a working compass. Clearing it unconditionally turns a recoverable
 * failure into a permanently broken `ix view`, which is the one outcome the
 * backup exists to prevent. sweepUpgradeOrphans puts it back on the next run.
 */
export function cleanupCompassSwap(compassDir: string, stagingDir: string, backupDir: string): void {
  rmQuiet(stagingDir);
  if (existsSync(compassDir)) rmQuiet(backupDir);
}

/**
 * Reclaim `.cli-staging-*` / `.cli-backup-*` and `.compass-staging-*` /
 * `.compass-backup-*` directories left behind by an upgrade that died mid-swap,
 * and put the install or the compass back if either is missing.
 *
 * Each swap has a window between its two renames in which nothing exists at the
 * destination. Ctrl-C, a killed process or a lost machine inside that window
 * terminates without running any catch, so in-process recovery cannot help —
 * and with no `ix` on disk the user cannot run `ix upgrade` to repair it either.
 *
 * The compass gets the same treatment as the CLI rather than a bare delete: its
 * backup is the only copy of a working bundle while the swap is torn, so a
 * sweep that just reclaimed it would turn an interrupted upgrade into a
 * permanently broken `ix view`.
 */
export function sweepUpgradeOrphans(ixHome: string, installDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(ixHome);
  } catch {
    return;
  }

  const recover = (prefix: string, dest: string, label: string) => {
    const backups = entries.filter((e) => e.startsWith(prefix)).sort();
    const last = backups[backups.length - 1];
    if (!existsSync(dest) && last) {
      try {
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(join(ixHome, last), dest);
        console.log(`  Recovered the previous ${label} from ${last} (an earlier upgrade was interrupted).`);
      } catch {
        /* fall through to the sweep; nothing is made worse by leaving it */
      }
    }
  };

  recover(".cli-backup-", installDir, "install");
  // join(installDir, "compass"), not the module-level COMPASS_DIR: that constant
  // is bound to the real IX_HOME, and this function takes ixHome as an argument
  // precisely so it can be pointed elsewhere. Using the constant would make a
  // test sweeping a temp directory rename its fixture into the developer's own
  // ~/.ix/cli/compass. Recovered second because the restore above may be what
  // creates the parent directory it needs.
  recover(".compass-backup-", join(installDir, "compass"), "compass");

  for (const name of entries) {
    if (
      name.startsWith(".cli-staging-") ||
      name.startsWith(".cli-backup-") ||
      name.startsWith(".compass-staging-") ||
      name.startsWith(".compass-backup-")
    ) {
      const target = join(ixHome, name);
      if (target !== installDir && existsSync(target)) rmQuiet(target);
    }
  }
}

/**
 * Repoint the Windows launchers at the newly installed tree.
 *
 * Only Windows needs this. install.sh writes an *absolute* path into the shim
 * on Windows (`$INSTALL_DIR/cli/dist/cli/main.js`) but on POSIX writes
 * `exec "$INSTALL_DIR/ix"`, which resolves through the install directory itself
 * and so never goes stale — rewriting that one would be churn at best, and at
 * worst fails on a root-owned /usr/local/bin that the user cannot write.
 *
 * That Windows path used to carry the release version in it
 * (`ix-<VERSION>-windows-amd64/`), which is why refreshing it mattered so much.
 * Both installers now lay the tree down flat, so it no longer changes between
 * releases — but the shim is still rewritten, because an install made by an
 * older script still has the version-encoded form on disk and nothing else
 * would ever repoint it.
 *
 * On Windows three shims exist, not two:
 *   - `%IX_HOME%\bin\ix.cmd`      written by install.ps1
 *   - `/usr/local/bin/ix`         written by install.sh when that dir is writable
 *   - `~/.local/bin/ix`           written by install.sh otherwise
 *
 * install.sh picks one of the latter two via pick_bin_dir() and *deletes* the
 * other as a stale duplicate, so refreshing a hard-coded `~/.local/bin/ix`
 * recreates the copy it removed while leaving the live one pointing into the
 * version directory the swap just deleted. Refresh whichever already exist.
 *
 * Returns a list of human-readable problems; empty means everything on PATH now
 * points at the new install.
 */
function refreshLaunchers(installDir: string, installedRoot: string, isWindows: boolean): string[] {
  if (!isWindows) return [];
  const problems: string[] = [];
  const entryPath = join(installedRoot, "cli", "dist", "cli", "main.js");

  {
    const cmdShim = join(IX_HOME, "bin", "ix.cmd");
    // Mirror install.ps1's *relative* form (`%~dp0..\cli\<dir>\ix.cmd`) rather
    // than embedding an absolute path. %~dp0 is expanded by cmd.exe at run
    // time, so the user's profile directory never has to survive a round trip
    // through a batch file's encoding — an absolute path written as "ascii"
    // silently corrupts any non-ASCII home (C:\Users\José\...) and produces a
    // launcher that points nowhere.
    const dirName = installedRoot === installDir ? "" : basename(installedRoot);
    if (dirName && !SAFE_DIR_NAME.test(dirName)) {
      problems.push(`refused to write ${cmdShim}: unsafe directory name ${JSON.stringify(dirName)}`);
    } else {
      const inner = dirName ? `%~dp0..\\cli\\${dirName}\\ix.cmd` : `%~dp0..\\cli\\ix.cmd`;
      try {
        // Leave a contributor's dev shim alone. scripts/dev/setup.sh points
        // this same file at their working tree; silently repointing it at the
        // released build makes their rebuilds appear to do nothing. This is the
        // convention the @ix/pro refresh below already follows.
        //
        // Read-or-default rather than existsSync-then-read: guarding a write
        // with an existence check is a TOCTOU (CodeQL js/file-system-race).
        let existing = "";
        try {
          existing = readFileSync(cmdShim, "utf-8");
        } catch {
          /* no shim yet — install.ps1 has not run on this machine */
        }
        if (existing && !existing.includes("%~dp0..\\cli\\") && !existing.includes(installDir)) {
          console.log("  Left your dev ix.cmd shim untouched (re-run scripts/dev/setup.sh to repoint it).");
        } else {
          mkdirSync(dirname(cmdShim), { recursive: true });
          writeFileSync(cmdShim, `@echo off\r\n"${inner}" %*\r\n`, "ascii");
        }
      } catch (err) {
        problems.push(`${cmdShim}: ${(err as Error).message}`);
      }
    }
  }

  // The bash shim install.sh writes under Git Bash / MSYS, which also carries
  // the version-encoded path. pick_bin_dir() puts it in whichever of these two
  // it chose, so refresh the one that is actually there.
  let jsPath = entryPath;
  try {
    jsPath = execFileSync("cygpath", ["-u", entryPath], { encoding: "utf-8" }).trim();
  } catch {
    /* use the windows path */
  }
  const body = `#!/usr/bin/env bash\nexec node "${jsPath}" "$@"\n`;
  const candidates = ["/usr/local/bin/ix", join(homedir(), ".local", "bin", "ix")];

  for (const target of candidates) {
    // Probe by reading rather than existsSync-then-write, which is a TOCTOU
    // (CodeQL js/file-system-race). Only refresh a shim that is already there:
    // creating one install.sh chose not to create would put a second,
    // competing `ix` on PATH.
    try {
      readFileSync(target);
    } catch {
      continue;
    }
    try {
      writeFileSync(target, body, { mode: 0o755 });
    } catch (err) {
      problems.push(`${target}: ${(err as Error).message}`);
    }
  }
  return problems;
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
            rmQuiet(stagingDir);
            rmQuiet(tmpDirRaw);
          };

          // Reclaim anything an interrupted upgrade left behind, and put the
          // install back if a previous run died between the two renames.
          sweepUpgradeOrphans(IX_HOME, installDir);

          try {
            rmQuiet(stagingDir);
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
          const stagedRoot = resolveStagedRoot(stagingDir, isWindows);
          const stagedEntry = join(stagedRoot, "cli", "dist", "cli", "main.js");
          if (!existsSync(stagedEntry)) {
            console.error("[error] Downloaded archive did not contain the expected CLI entry point.");
            console.error(`  Expected: ${stagedEntry}`);
            console.error("  Your existing install is untouched.");
            cleanupStaging();
            process.exit(1);
          }

          // Actually start the staged CLI before trusting it. existsSync on
          // main.js cannot distinguish a good tree from a truncated extraction
          // or a tarball whose node_modules is missing a lazily-required
          // module — and the working install is about to be deleted, so this is
          // the last point at which that is recoverable.
          try {
            execFileSync(process.execPath, [stagedEntry, "--version"], {
              stdio: ["ignore", "ignore", "pipe"],
              timeout: 120000,
            });
          } catch (err) {
            const e = err as Error & { stderr?: Buffer | string };
            console.error("[error] The downloaded CLI did not run.");
            console.error(`  ${String(e.stderr || "").trim() || e.message}`);
            console.error("  Your existing install is untouched.");
            cleanupStaging();
            process.exit(1);
          }

          // Move the old install aside rather than deleting it outright, so a
          // failure part-way through the swap can put it back instead of
          // leaving the user with nothing.
          const backupDir = join(IX_HOME, `.cli-backup-${process.pid}`);
          try {
            // installStagedTree owns the staged-root resolution. It swaps in the
            // *inner* directory on Windows, so the zip's ix-<version>-<platform>/
            // wrapper does not get reproduced inside cli\ — which is what put
            // compass at cli\ix-<version>-<platform>\compass while COMPASS_DIR
            // and findCompassDist only ever read cli\compass. One shape on every
            // platform, and one function a test can hold to that.
            installStagedTree(installDir, stagingDir, backupDir, isWindows);
          } catch (err) {
            console.error("[error] Failed to install the CLI update.");
            console.error(`  ${(err as Error).message}`);
            if (existsSync(installDir)) {
              console.error("  Your existing install is untouched.");
            } else {
              // The restore inside swapInStagedTree could not put it back.
              // Say where the surviving copy is — otherwise the user cannot
              // tell that the install is gone rather than merely unchanged.
              console.error(`  Your previous install is still at: ${backupDir}`);
              console.error(`  Rename that directory to ${installDir} to restore it, or reinstall:`);
              console.error(
                `  curl -fsSL https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main/scripts/install/install.sh | bash`
              );
            }
            cleanupStaging();
            process.exit(1);
          }
          rmQuiet(tmpDirRaw);

          // Repoint every launcher on PATH at the new install. This is not
          // best-effort any more: the tree the old shims named has just been
          // deleted, so a shim left stale is a CLI that no longer starts.
          const installedRoot = (isWindows ? soleChildDir(installDir) : null) ?? installDir;
          const shimProblems = refreshLaunchers(installDir, installedRoot, isWindows);
          if (shimProblems.length > 0) {
            console.error("[error] Installed the update but could not repoint the launcher:");
            for (const p of shimProblems) console.error(`  ${p}`);
            console.error("  Re-run the installer to repair it:");
            console.error(
              `  curl -fsSL https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main/scripts/install/install.sh | bash`
            );
            process.exit(1);
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

          // Which step failed decides where to look: a download failure is a
          // network, URL or proxy problem; an extract failure is a local tar
          // problem. One `catch` reporting both as "could not download" sent a
          // Windows investigation at the wrong half — and `tar` ran with stdio
          // "ignore", so the only step that had actually failed was also the
          // one that printed nothing at all.
          const compassStaging = join(IX_HOME, `.compass-staging-${process.pid}`);
          const compassBackup = join(IX_HOME, `.compass-backup-${process.pid}`);
          let stage = "download";
          try {
            execFileSync("curl", ["-fsSL", compassUrl, "-o", compassTar], {
              stdio: ["ignore", "inherit", "inherit"],
              timeout: 60000,
            });
            stage = "extract";
            installCompassBundle(compassTar, COMPASS_DIR, compassStaging, compassBackup);
            // Its own stage: a failure here is a bundle that installed fine and
            // did not get stamped, which is not an extract problem and should
            // not be reported as one.
            stage = "stamp";
            writeFileSync(COMPASS_VERSION_FILE, compassLatest);
            console.log(`[ok] Compass upgraded to ${compassLatest}`);
          } catch (err) {
            console.error(`[!!] Compass ${stage} failed: ${describeExecFailure(err)}`);
            // Whether this is a degraded upgrade or a broken `ix view` depends
            // on what survived, and only the second is worth alarming about.
            // getInstalledCompassVersion reports "0.0.0" for a bundle with no
            // stamp beside it, so read the disk rather than quoting a version.
            if (existsSync(join(COMPASS_DIR, "index.html"))) {
              console.error(`     ix view keeps working on the compass already installed (source: ${compassUrl})`);
            } else if (existsSync(compassBackup)) {
              // swapInStagedTree moved the old compass aside and then could not
              // put it back, so this is the only copy left. Name it rather than
              // letting the cleanup below take it, exactly as the CLI swap does.
              console.error(`     Your previous compass is still at: ${compassBackup}`);
              console.error(`     Rename that directory to ${COMPASS_DIR} to restore ix view, or re-run ix upgrade.`);
            } else {
              console.error(`     ix view stays unavailable until this succeeds (source: ${compassUrl})`);
            }
          }
          cleanupCompassSwap(COMPASS_DIR, compassStaging, compassBackup);
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
