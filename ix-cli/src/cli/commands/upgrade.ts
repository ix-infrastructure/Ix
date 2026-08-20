import { Command } from "commander";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, lstatSync, renameSync, readdirSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import chalk from "chalk";
import { BACKEND_IMAGE, checkBackendImage, isNonStandardBackend } from "../backend-status.js";
import { canRenderProgress } from "../stderr.js";

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
    // Bounded, because this is now awaited on a command the user is watching:
    // `ix docker start` stamps the version it pulled. Undici's default
    // headersTimeout is 300s, so a proxy or captive portal that accepts the
    // connection and never answers would stall the command for five minutes
    // with nothing printed. Every other fetch in this codebase bounds itself.
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_ORG}/${repo}/releases/latest`,
      { signal: AbortSignal.timeout(10_000) }
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
  return installedCompass().version;
}

/**
 * The installed bundle's stamp, plus whether there is a bundle at all.
 *
 * `present` is carried separately rather than being encoded as version "0.0.0".
 * Overloading the version number conflates two states that need opposite
 * answers: a *missing* bundle must be repaired from dist, while a *present*
 * release bundle whose stamp is unreadable must not be — 0.0.0 is also what
 * `parseCompassStamp` returns for a stamp truncated by a full disk or a kill
 * during the non-atomic write, and repairing that downgrades a working bundle.
 *
 * Returns the whole stamp rather than just the number because the source marker
 * is half the answer, and reading the file once keeps the two from disagreeing.
 */
function installedCompass(): CompassStamp & { present: boolean } {
  const present = existsSync(join(COMPASS_DIR, "index.html"));
  if (!present) return { source: "dist", version: "0.0.0", present };
  return { ...readCompassStamp(), present };
}

/**
 * What `compass/.version` says about the bundle beside it.
 *
 * The stamp is written by two different producers in two different version
 * series, and until now it recorded no way to tell them apart (#376):
 *
 * - the **release** workflow stamps the bundle it ships with the **Ix** version
 *   (`0.9.2`), because the bundle is built from system-compass `main` at release
 *   time and has no dist release number of its own;
 * - **install.sh** and the compass-upgrade path below stamp the
 *   **ix-compass-dist** release they downloaded (`0.3.0`).
 *
 * `isNewer(distLatest, stamp)` is only meaningful for the second. Against the
 * first it compares two unrelated series and is correct purely by accident of
 * Ix's numbers currently being the larger ones: the first ix-compass-dist tag
 * above the running Ix version makes `isNewer` true and replaces a *newer*
 * bundled compass with an older dist build. That is the same class of failure
 * as #365/#366, reached from the other end.
 *
 * So the stamp declares its own provenance, and the comparison only runs where
 * it means something. The provenance rides in **semver build metadata**, on one
 * line, because this file has readers we cannot upgrade:
 *
 *     0.9.3+release.7f98724     a bundle built from system-compass main
 *     0.3.0                     an ix-compass-dist download
 *
 * That shape is load-bearing. Every already-shipped CLI reads this file with
 * `getTrackedVersion` — `readFileSync(...).trim()`, the *whole file* — and hands
 * the result straight to `splitVersion`. A multi-line `key=value` stamp makes
 * that return the entire blob, whose major parses as `Number("source=release…")`
 * = NaN → 0; the old CLI then sees a 1.x release as `[0,0,0]` and downloads
 * ix-compass-dist over the newer bundle it just installed — reintroducing #376
 * through the format change itself, on exactly the upgrade that ships the fix.
 * `splitVersion` already drops everything after `+` ("Build metadata (`+sha`)
 * never participates in precedence"), so an old CLI reads `0.9.3+release.7f98724`
 * as `0.9.3` and behaves precisely as it does today.
 *
 * A bare version number is both the legacy stamp (everything up to v0.9.2) and
 * the dist form going forward, read as dist-series either way — which is what
 * install.sh wrote, is the majority of installs in the wild, and leaves those
 * exactly as correct as they are today. Release-bundled legacy stamps stay
 * accidentally-correct until compass-dist passes the Ix version, and no worse
 * than before; new releases carry the marker and are immune.
 */
export type CompassStamp = { source: "release" | "dist"; version: string };

export function parseCompassStamp(raw: string): CompassStamp {
  // First line only. Nothing writes a second one, but a stray trailing line
  // must not turn the version into an unparseable blob — that is the failure
  // this format exists to avoid, and it should not survive in our own reader.
  const text = (raw.split(/\r?\n/)[0] ?? "").trim();
  if (!text) return { source: "dist", version: "0.0.0" };

  const plus = text.indexOf("+");
  if (plus < 0) return { source: "dist", version: text };

  const version = text.slice(0, plus).trim();
  // No version means the stamp tells us nothing, marker or not — don't let a
  // bare `+release` assert provenance it has no version to attach to.
  if (!version) return { source: "dist", version: "0.0.0" };

  const build = text.slice(plus + 1).trim();
  // `release` or `release.<sha>`. Matched on the first dot-separated identifier
  // so the commit stays free to change shape.
  const source = build.split(".")[0] === "release" ? "release" : "dist";
  return { source, version };
}

function readCompassStamp(): CompassStamp {
  try {
    if (!existsSync(COMPASS_VERSION_FILE)) return { source: "dist", version: "0.0.0" };
    return parseCompassStamp(readFileSync(COMPASS_VERSION_FILE, "utf-8"));
  } catch {
    return { source: "dist", version: "0.0.0" };
  }
}

/**
 * Should `ix upgrade` offer to replace the installed compass with the latest
 * ix-compass-dist release?
 *
 * Only when the two numbers are in the same series. A release-bundled compass
 * is never replaced: it was built from system-compass `main` when the CLI was
 * cut, so it is at least as new as any dist release published before it, and a
 * dist release published *after* it arrives with the next Ix release, which
 * bundles `main` again. The dist download stays the **repair** path for a
 * missing or gutted bundle, and `present` — `index.html` on disk — is what
 * decides that, deliberately ahead of the source check so a gutted *release*
 * bundle is still repaired.
 *
 * `present` rather than version "0.0.0": that number is also what
 * `parseCompassStamp` yields for a stamp truncated by a full disk or a kill
 * during the non-atomic write, and a present, perfectly serviceable release
 * bundle must not be "repaired" with an older dist build on the strength of a
 * damaged stamp. An unreadable stamp beside a real bundle falls through to the
 * dist comparison, which is what every shipped CLI already does with it.
 *
 * Takes the stamp as an argument rather than reading it: this decision is the
 * whole point of #376, and with the file read inlined the only thing a test
 * could reach was parseCompassStamp — so deleting the source check left every
 * test passing while the inversion came straight back.
 */
export function shouldOfferCompassUpgradeFor(
  compassLatest: string | undefined,
  installed: CompassStamp & { present: boolean },
): boolean {
  if (!compassLatest) return false;
  if (!installed.present) return true; // missing or gutted — repair.
  if (installed.source === "release") return false;
  return isNewer(compassLatest, installed.version);
}

function shouldOfferCompassUpgrade(compassLatest: string | undefined): boolean {
  return shouldOfferCompassUpgradeFor(compassLatest, installedCompass());
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
 * Whether to tell the user their backend is behind.
 *
 * The two branches of `checkForUpdate` — cached and freshly fetched — each made
 * this decision inline, so a change to one silently did not apply to the other.
 * Pure, so the thing the user actually sees is testable without a clock, a
 * cache file or a network.
 *
 * The tracked version is the whole input on purpose. It is written wherever the
 * image is installed or pulled, so it is the record of what is running; nothing
 * else available locally improves on it, and the one thing that looks like it
 * would — comparing the container against `docker image inspect ...:latest` —
 * is registry-blind and reports a months-old image as current.
 */
export function backendUpdateAvailable(
  backendLatest: string | undefined,
  trackedVersion: string,
): boolean {
  return !!backendLatest && isNewer(backendLatest, trackedVersion);
}

/**
 * Record the backend release in its stamp file. Returns whether it was written.
 *
 * `mkdirSync` because IX_HOME may not exist yet — a stamp that fails to write
 * leaves the tracked version behind for ever, and the notice it drives says
 * "update available" on every command with no way for the user to see why.
 *
 * A falsy version is refused rather than written: not knowing which release we
 * are on is not the same as being on none of them. Being wrong *behind* costs a
 * nag, while being wrong *ahead* hides a genuinely stale backend and stops
 * `ix upgrade` from ever fetching it — so where there is a choice, this errs
 * behind. (It is not always a choice: the GHCR `:latest` tag and the
 * `ix-memory-layer-dist` release are separate publishing surfaces with nothing
 * correlating them, so a release cut between the two can be recorded ahead of
 * the image actually pulled. `ix upgrade` has always had that race; correcting
 * it needs the backend to report its own version.)
 *
 * The write does not throw — callers differ on whether a failure should be
 * fatal, so they decide from the return value rather than from an exception.
 * Not a general component-stamp writer: the compass stamp is written with a
 * trailing newline that `parseCompassStamp` depends on.
 */
export function writeVersionStamp(
  versionFile: string,
  version: string | null | undefined,
): boolean {
  if (!version) return false;
  try {
    mkdirSync(dirname(versionFile), { recursive: true });
    writeFileSync(versionFile, version);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this compose file runs the backend from the moving `:latest` tag.
 *
 * The premise of stamping after a pull is that `--pull always` fetched the
 * current release — which holds only if the file being started actually tracks
 * `:latest`. `ix docker start` falls back to any `docker-compose.yml` in the
 * working directory, so it may well not: a compose that pins `:1.0.13`, pins a
 * digest, or points at a locally-built image pulls something that is not the
 * latest release, and stamping it would put a version in the file that the
 * running container does not have.
 *
 * That is the one way this file must never be wrong, so the check is on the
 * image reference itself rather than on which path the compose came from — a
 * user is free to edit the copy under IX_HOME, and it is what the file *says*
 * that decides what gets pulled.
 */
export function composeTracksLatestBackend(composeText: string): boolean {
  // Compared as a whole string rather than matched as a pattern: BACKEND_IMAGE
  // is interpolated, and its dots are regex wildcards, so a pattern here would
  // also accept `ghcrXio/...` and anything else that happened to line up.
  const wanted = `${BACKEND_IMAGE}:latest`;
  return composeText.split(/\r?\n/).some((line) => {
    const declared = /^\s*image:\s*(.+?)\s*$/.exec(line);
    if (!declared) return false;
    return declared[1].replace(/^["']|["']$/g, "") === wanted;
  });
}

/**
 * Record the backend release after something has pulled `:latest`.
 *
 * `.backend-version` is written at install time (install.sh, install.ps1) and by
 * `ix upgrade` — but not by `ix docker start`, which pulls `:latest` on every
 * cold start. So anyone who took a newer image that way kept a file naming the
 * release they installed while running a later one, and was told to upgrade on
 * every command for ever.
 *
 * The fix belongs at the write, not at the read. Having just pulled `:latest`,
 * the running image IS the current release, so the release is simply what to
 * record; nothing has to be inferred about it afterwards. Inferring it is what
 * cannot be done safely here — `docker image inspect ...:latest` never contacts
 * a registry, so a container matching the local `:latest` proves only that
 * nothing has been pulled since, which is equally true of a months-old image.
 *
 * Prefers the version cache `checkForUpdate` already maintains: `main.ts` fires
 * that unawaited on this very command, so fetching again races it for the same
 * tag against a 60/hour unauthenticated rate limit. An hour of staleness here
 * only ever errs behind.
 *
 * If the release cannot be established the stamp is left alone: the user keeps a
 * notice they may not need, which is the failure worth having.
 */
export async function stampBackendVersionAfterPull(composeFile: string): Promise<void> {
  try {
    if (!composeTracksLatestBackend(readFileSync(composeFile, "utf-8"))) return;
    const cached = readCache();
    const latest =
      cached && Date.now() - cached.checkedAt < 3600_000 && cached.backendLatest
        ? cached.backendLatest
        : await fetchLatestRelease(MEMORY_LAYER_DIST_REPO);
    writeVersionStamp(BACKEND_VERSION_FILE, latest);
  } catch {
    /* offline, rate-limited, unreadable compose: the tracked version stands */
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
/**
 * The body of `%IX_HOME%\bin\ix.cmd`, which is the launcher every native
 * Windows shell actually runs.
 *
 * It checks its own target before invoking it, because the failure it is
 * guarding against is unrecoverable from inside the CLI. `ix upgrade` on any
 * version before 0.9.0 refreshed only the *bash* shim under Git Bash and left
 * this file pointing at a `cli\ix.cmd` that the upgrade had just replaced with
 * a version-nested directory (Ix#385). The user is then holding a launcher that
 * cannot start the program that would have told them what to do — cmd.exe says
 * only:
 *
 *   '"C:\Users\...\.ix\bin\..\cli\ix.cmd"' is not recognized as an internal or
 *   external command, operable program or batch file.
 *
 * which names the wrapper rather than the cause and reads like a broken install
 * rather than a broken upgrade. So the recovery instruction has to live in the
 * batch file itself. Nothing else in the system can reach them at that point:
 * `ix doctor` is exactly as unreachable as `ix`.
 *
 * `^|` is an escaped pipe — cmd.exe would otherwise treat it as a pipeline.
 */
export function windowsShimBody(inner: string): string {
  return [
    "@echo off",
    `if not exist "${inner}" goto :ix_missing`,
    `"${inner}" %*`,
    "exit /b %errorlevel%",
    "",
    ":ix_missing",
    "echo(",
    `echo   The Ix CLI is not at "${inner}".`,
    "echo(",
    "echo   An 'ix upgrade' from a version before 0.9.0 moved the CLI and left",
    "echo   this launcher pointing at the old path. Reinstalling repairs it:",
    "echo(",
    "echo     irm https://ix-infra.com/install.ps1 ^| iex",
    "echo(",
    "exit /b 1",
    "",
  ].join("\r\n");
}

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
export interface TarAttempt {
  bin: string;
  file: string;
  dest: string;
}

/**
 * Windows' own bsdtar, or null if this box predates it.
 *
 * Present since Windows 10 1803. It takes native paths and is not reached
 * through any MSYS argument rewriting, so it is the one combination on Windows
 * that cannot be mismatched.
 */
export function systemTarPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): string | null {
  const root = env.SystemRoot || env.windir;
  if (!root) return null;
  const candidate = join(root, "System32", "tar.exe");
  return exists(candidate) ? candidate : null;
}

/**
 * The ways to invoke tar, best first, as matched (binary, path-form) pairs.
 *
 * The binary and the shape of the paths handed to it have to be chosen
 * together, and they used to be decided independently: the paths were rewritten
 * to Cygwin form whenever `cygpath` existed, while the binary was left to
 * whatever PATH resolved. Git for Windows supplies `cygpath`, and Windows 10
 * 1803+ supplies System32\tar.exe, so on an ordinary Windows dev box the
 * rewrite happened and then bsdtar — which has never heard of `/cygdrive/c` —
 * was asked to open the result:
 *
 *     tar: Error opening archive: Failed to open '/cygdrive/c/Users/...'
 *
 * So: prefer the system tar with native paths, which is unambiguous. Fall back
 * to PATH tar with native paths, then to PATH tar with converted paths for a
 * genuine MSYS-only environment. Trying rather than detecting, because "which
 * tar is this" has no reliable answer and the cost of being wrong is one failed
 * extract into a scratch directory.
 */
export function cygpathToUnix(windowsPath: string): string | null {
  try {
    const converted = execFileSync("cygpath", ["-u", windowsPath], { encoding: "utf-8" }).trim();
    return converted || null;
  } catch {
    // No cygpath: there is no MSYS tar to need the converted form either.
    return null;
  }
}

export function tarAttempts(
  tarPath: string,
  destDir: string,
  // Injectable so the ordering can be tested off Windows, where cygpath does
  // not exist and every attempt would otherwise collapse to the native form —
  // hiding the very inversion this exists to prevent.
  convert: (p: string) => string | null = cygpathToUnix
): TarAttempt[] {
  if (process.platform !== "win32") {
    return [{ bin: "tar", file: tarPath, dest: destDir }];
  }

  const attempts: TarAttempt[] = [];
  const systemTar = systemTarPath();
  if (systemTar) attempts.push({ bin: systemTar, file: tarPath, dest: destDir });
  attempts.push({ bin: "tar", file: tarPath, dest: destDir });

  const file = convert(tarPath);
  const dest = convert(destDir);
  if (file && dest) attempts.push({ bin: "tar", file, dest });

  return attempts;
}

export function installCompassBundle(
  tarPath: string,
  compassDir: string,
  stagingDir: string,
  backupDir: string
): void {
  let lastError: unknown = null;
  for (const attempt of tarAttempts(tarPath, stagingDir)) {
    // Each attempt gets a clean directory: a tar that fails partway still
    // leaves files behind, and the index.html check below would then be
    // answering about the wreckage of an earlier try.
    rmQuiet(stagingDir);
    mkdirSync(stagingDir, { recursive: true });
    try {
      execFileSync(
        attempt.bin,
        ["-xzf", attempt.file, "-C", attempt.dest, "--strip-components=1"],
        // Capture stderr rather than discarding it: this is the step that failed
        // on Windows and it left nothing behind to diagnose.
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;

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
  // index.html, not the directory: a `compass/` holding only a `.version` is a
  // real state — install.ps1 used to create exactly that, and v0.7.0-v0.8.1
  // shipped an empty compass/ — and it is not a compass anyone can serve. A
  // bare existsSync(compassDir) would call that "back in place" and drop a
  // backup the caller had just told the user to go and rescue. Safe on the
  // success path: installCompassBundle proves index.html is there before it
  // swaps, so this is the same test findCompassDist applies.
  if (existsSync(join(compassDir, "index.html"))) rmQuiet(backupDir);
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

  // `intact` decides whether what is at `dest` counts as a real thing or a
  // husk, and it must be the same test the swap's own cleanup applies.
  // cleanupCompassSwap uses `index.html`, not a bare existsSync, and says why:
  // a `compass/` holding only a `.version` is a real state, and a bare
  // existsSync "would call that 'back in place' and drop a backup the caller had
  // just told the user to go and rescue".
  //
  // recover() used a bare existsSync, so the two disagreed on exactly the state
  // that matters: with a husk at dest it declined to restore, and the sweep
  // below then deleted the only working bundle. Preserved by cleanup, destroyed
  // by the sweep. The same reasoning applies to the CLI — a `cli/` with no entry
  // point cannot start and is not an install worth keeping a backup from.
  const recover = (prefix: string, dest: string, intact: string, label: string) => {
    const backups = entries.filter((e) => e.startsWith(prefix)).sort();
    const last = backups[backups.length - 1];
    if (!existsSync(join(dest, intact)) && last) {
      try {
        rmQuiet(dest);
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(join(ixHome, last), dest);
        console.log(`  Recovered the previous ${label} from ${last} (an earlier upgrade was interrupted).`);
      } catch {
        /* fall through to the sweep; nothing is made worse by leaving it */
      }
    }
  };

  recover(".cli-backup-", installDir, join("cli", "dist", "cli", "main.js"), "install");
  // join(installDir, "compass"), not the module-level COMPASS_DIR: that constant
  // is bound to the real IX_HOME, and this function takes ixHome as an argument
  // precisely so it can be pointed elsewhere. Using the constant would make a
  // test sweeping a temp directory rename its fixture into the developer's own
  // ~/.ix/cli/compass. Recovered second because the restore above may be what
  // creates the parent directory it needs.
  recover(".compass-backup-", join(installDir, "compass"), "index.html", "compass");

  for (const name of entries) {
    // The download scratch, moved here from os.tmpdir() with #349. It holds a
    // multi-MB archive, and leaving TEMP also left the OS's own cleanup — so an
    // upgrade killed mid-download would park that in ~/.ix forever. These two
    // prefixes are deliberately NOT `-backup-`: `recover()` above renames the
    // last `.cli-backup-*` over the install directory, and a stray archive
    // directory must never be a candidate for that.
    const isDownload =
      name.startsWith(".cli-download-") || name.startsWith(".compass-download-");

    if (
      name.startsWith(".cli-staging-") ||
      name.startsWith(".cli-backup-") ||
      name.startsWith(".compass-staging-") ||
      name.startsWith(".compass-backup-") ||
      isDownload
    ) {
      // Never reclaim a directory another live `ix upgrade` is downloading
      // into. While the scratch lived in os.tmpdir() no sweep could match it;
      // moving it under IX_HOME put it in range for the whole 300s curl
      // timeout, so a second upgrade — a second terminal, or bootstrap.sh
      // re-running `ix upgrade` when it finds compass missing — would delete
      // the first run's archive out from under it. On POSIX the unlink
      // succeeds silently and curl still exits 0, so the victim fails at the
      // extract and reports a download it actually completed.
      //
      // Downloads only: staging and backup directories are named `<prefix><pid>`
      // with no trailing segment, so they carry no pid this can read, and
      // widening the guard to them would change reclaim behaviour that is not
      // what this PR is about.
      if (isDownload && isLiveScratch(name)) continue;
      const target = join(ixHome, name);
      if (target !== installDir && existsSync(target)) rmQuiet(target);
    }
  }
}

/**
 * Does this scratch directory belong to a process that is still running?
 *
 * Download directories are named `<prefix><pid>-<random>`, so the owner is
 * recoverable from the name alone — no lockfile to leak, and a crashed run
 * leaves a pid that no longer resolves, which is exactly when the sweep should
 * reclaim it. Anything unparseable is treated as dead: the pre-existing naming
 * had no pid, and those must stay collectable.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the process is
 * addressable. EPERM means it exists but belongs to another user, which still
 * counts as live.
 */
function isLiveScratch(name: string): boolean {
  const pid = Number(/-(\d+)-[^-]*$/.exec(name)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Create the scratch directory an upgrade downloads into, having first
 * reclaimed whatever an interrupted run left behind.
 *
 * The two steps live in one function because their **order** is load-bearing
 * and was otherwise only a comment. `sweepUpgradeOrphans` now reclaims
 * `.cli-download-*` and `.compass-download-*`, so running it *after* the
 * scratch is created deletes the archive that is about to be extracted — which
 * breaks every upgrade on every platform, not just the Windows one #349 is
 * about. The old call sat between the download and the extract, safe only
 * while the scratch lived in `os.tmpdir()`; moving the downloads under IX_HOME
 * is what made the position matter. Sweeping first also puts an interrupted
 * install back even when the download then fails.
 *
 * `mkdirSync` first because `mkdtemp` needs the parent to exist, and a first
 * upgrade after a manual install can reach here before anything has created it.
 *
 * The pid goes in the name so a *concurrent* upgrade's sweep can tell this
 * directory is still in use — see isLiveScratch. Sweeping first protects this
 * run from itself; the pid protects it from the other one.
 */
export function prepareDownloadDir(ixHome: string, installDir: string, prefix: string): string {
  mkdirSync(ixHome, { recursive: true });
  sweepUpgradeOrphans(ixHome, installDir);
  // mkdtemp appends its own randomness, so the shape is `<prefix><pid>-<rand>`
  // and isLiveScratch's `-<digits>-<rand>` match finds the pid.
  return mkdtempSync(join(ixHome, `${prefix}${process.pid}-`));
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
          writeFileSync(cmdShim, windowsShimBody(inner), "ascii");
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
    const hasCompassUpdate = shouldOfferCompassUpgrade(cache.compassLatest);
    const hasBackendUpdate = backendUpdateAvailable(
      cache.backendLatest,
      getTrackedVersion(BACKEND_VERSION_FILE),
    );
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
    const hasCompassUpdate = shouldOfferCompassUpgrade(compassLatest ?? undefined);
    const hasBackendUpdate = backendUpdateAvailable(
      backendLatest ?? undefined,
      getTrackedVersion(BACKEND_VERSION_FILE),
    );
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
  // Erase whatever progress frame is mid-render before printing over it. There
  // is no such frame when stderr is not a terminal, so this would be 82 bytes
  // of padding and two carriage returns deposited straight into the captured
  // output — and this notice fires on ordinary commands, so it leaked into
  // redirected output that had no progress bar to begin with.
  if (canRenderProgress()) process.stderr.write("\r" + " ".repeat(80) + "\r");
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

      // Reclaim orphans and restore an interrupted swap once, up front, for
      // every real `ix upgrade`.
      //
      // Both other sweep calls sit behind "something needs updating" — one
      // inside the CLI branch, one inside the compass branch. That was already
      // fragile, and #376 tightened the compass gate to skip release-bundled
      // compasses entirely, so on a healthy current install *neither* fires and
      // nothing is ever reclaimed. The archives this PR teaches the sweep about
      // are multi-MB, and the whole reason for sweeping them is that leaving
      // os.tmpdir() also left the OS's own cleanup — a sweep that only runs when
      // an update happens to be available does not deliver that.
      //
      // Cheap when there is nothing to do: one readdir of ~/.ix. The calls
      // inside prepareDownloadDir stay, because that is where the
      // sweep-before-scratch ordering is enforced; they simply find nothing.
      if (!opts.check) sweepUpgradeOrphans(IX_HOME, join(IX_HOME, "cli"));

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

          // Under IX_HOME, not os.tmpdir(). #349 is a Windows install that died
          // because TEMP arrived in 8.3 short form (`C:\Users\WIN10\~1\...`) on
          // a profile named `C:\Users\Win 10`, and setting TEMP to a path
          // without a space let the same install finish. install.ps1 was moved
          // off TEMP for that; `ix upgrade` stages through os.tmpdir(), which on
          // Windows *is* TEMP verbatim, so the same hazard was left live on the
          // upgrade path — where it breaks an install that already works.
          //
          // IX_HOME comes from USERPROFILE in its long form. prepareDownloadDir
          // also reclaims anything an interrupted upgrade left behind, and must
          // do so before the scratch exists — see its docstring.
          const tmpDirRaw = prepareDownloadDir(IX_HOME, installDir, ".cli-download-");
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
            // rmQuiet, not a bare rmSync: this directory now lives under the
            // user profile rather than TEMP, where an AV or indexer handle on
            // the archive curl just wrote is routine — and a throw here would
            // replace the actionable message above with a raw EPERM.
            rmQuiet(tmpDirRaw);
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
            // A failed stamp has to surface here, as it did when this was a bare
            // writeFileSync: on a read-only or permission-denied IX_HOME the
            // image is pulled but the file never moves, so reporting success
            // would re-pull on every run and keep nagging with nothing to
            // explain it.
            if (!writeVersionStamp(BACKEND_VERSION_FILE, backendLatest)) {
              throw new Error(`could not record the backend version in ${BACKEND_VERSION_FILE}`);
            }
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
      if (shouldOfferCompassUpgrade(compassLatest ?? undefined)) {
        console.log(
          `Compass update available: ${compassCurrent === "0.0.0" ? "none" : compassCurrent} → ${chalk.green(compassLatest)}`
        );

        if (!opts.check) {
          // Sweep here too, not only in the CLI branch above. That call sits
          // behind "the CLI itself needs updating", so on a machine already on
          // the latest CLI it never runs — and this block is about to create
          // the very scratch directories it reclaims. Without this, a compass
          // swap interrupted on a current install stays torn until the *next*
          // CLI release, which is the one moment the user cannot wait for: the
          // backup may hold their only compass. Idempotent when the CLI branch
          // already ran, since it finds nothing left. (installDir is scoped to
          // that branch; COMPASS_DIR's parent is the same directory.)
          //
          // Under IX_HOME for the same reason as the CLI download above (#349),
          // and swept before the scratch exists for the same reason too.
          const compassUrl = `https://github.com/${GITHUB_ORG}/${COMPASS_DIST_REPO}/releases/download/v${compassLatest}/compass-${compassLatest}.tar.gz`;
          const compassTmp = prepareDownloadDir(
            IX_HOME,
            dirname(COMPASS_DIR),
            ".compass-download-",
          );
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
            // A bare dist release number. Dist needs no marker: bare *is* the
            // dist form, it is what every shipped CLI already expects to find
            // here, and this number really is in the ix-compass-dist series —
            // which is the series the next run will compare it against
            // (parseCompassStamp, #376).
            writeFileSync(COMPASS_VERSION_FILE, `${compassLatest}\n`);
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
          // rmQuiet, not a bare rmSync — same reason as the CLI download above,
          // and this one runs on the *success* path. A throw here escapes the
          // action, so writeCache() below never runs and the "update available"
          // notice keeps firing for the compass just installed.
          rmQuiet(compassTmp);
        }
      } else if (compassLatest && readCompassStamp().source === "release") {
        // Not "already latest" — it is a different series. Say what it is, so
        // nobody reads a bundled 0.9.2 as a compass version and files #376 again.
        console.log(
          `[ok] Compass is the build bundled with Ix ${compassCurrent} (ix-compass-dist ${compassLatest} not applied)`
        );
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
