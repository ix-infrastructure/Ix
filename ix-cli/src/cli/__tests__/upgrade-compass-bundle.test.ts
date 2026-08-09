import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  cleanupCompassSwap,
  installCompassBundle,
  sweepUpgradeOrphans,
} from "../commands/upgrade.js";

// The compass repair used to empty COMPASS_DIR and extract into the hole, so
// any tar failure left no compass at all. While the Windows bundle sat
// unreachable at cli\ix-<version>-<platform>\compass that cost nothing — there
// was never anything at COMPASS_DIR to lose. install.ps1 now puts the bundle
// exactly there, which makes the destructive order a way for the repair path to
// break the install it is meant to rescue.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ix-compass-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An installed compass, as findCompassDist would accept it. */
function seedInstalledCompass(marker: string): string {
  const compassDir = join(root, "cli", "compass");
  mkdirSync(compassDir, { recursive: true });
  writeFileSync(join(compassDir, "index.html"), marker);
  writeFileSync(join(compassDir, ".version"), "0.1.0");
  return compassDir;
}

/**
 * A real compass-shaped tarball, nested one level the way ix-compass-dist
 * ships it — `--strip-components=1` is only correct against that shape, so
 * building the fixture any flatter would test a layout that does not exist.
 */
function buildCompassTarball(name: string, files: Record<string, string>): string {
  const src = join(root, `src-${name}`);
  const inner = join(src, `compass-${name}`);
  mkdirSync(inner, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(inner, rel), body);
  }
  // Relative paths, run from `src`. Git for Windows puts GNU tar on PATH ahead
  // of System32's bsdtar, and GNU tar reads `C:\...` in -f as a host:path
  // remote spec — "Cannot connect to C: resolve failed". That is the same trap
  // installCompassBundle sidesteps with cygpath; the fixture just avoids
  // absolute paths rather than depending on which tar answers.
  execFileSync("tar", ["-czf", `../${name}.tar.gz`, `compass-${name}`], {
    cwd: src,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return join(root, `${name}.tar.gz`);
}

const staging = () => join(root, ".compass-staging-test");
const backup = () => join(root, ".compass-backup-test");

describe("installCompassBundle", () => {
  it("installs the bundle when the archive is good", () => {
    const compassDir = seedInstalledCompass("<!-- old -->");
    const tarPath = buildCompassTarball("0.2.0", {
      "index.html": "<!-- new -->",
      "app.js": "console.log(1);\n",
    });

    installCompassBundle(tarPath, compassDir, staging(), backup());

    expect(readFileSync(join(compassDir, "index.html"), "utf-8")).toBe("<!-- new -->");
    expect(existsSync(join(compassDir, "app.js"))).toBe(true);
    // The replaced tree goes entirely, rather than the new files landing on top
    // of the old ones — a stale .version would misreport what is installed.
    expect(existsSync(join(compassDir, ".version"))).toBe(false);
  });

  it("leaves the installed compass intact when tar fails", () => {
    const compassDir = seedInstalledCompass("<!-- keep me -->");

    expect(() =>
      installCompassBundle(join(root, "not-a-real-archive.tar.gz"), compassDir, staging(), backup())
    ).toThrow();

    // The whole point: a failed repair must not be what breaks `ix view`.
    expect(readFileSync(join(compassDir, "index.html"), "utf-8")).toBe("<!-- keep me -->");
  });

  it("leaves the installed compass intact when the archive has no index.html", () => {
    const compassDir = seedInstalledCompass("<!-- keep me -->");
    const tarPath = buildCompassTarball("empty", { "README.md": "no ui here\n" });

    // An extract that succeeds but produces no index.html is not a compass.
    // Swapping it in would hand findCompassDist a directory it rejects, and the
    // caller stamps .version straight after — telling `ix upgrade` never to
    // retry the download that would have fixed it.
    expect(() => installCompassBundle(tarPath, compassDir, staging(), backup())).toThrow(
      /index\.html/
    );
    expect(readFileSync(join(compassDir, "index.html"), "utf-8")).toBe("<!-- keep me -->");
  });

  it("installs into a fresh tree when no compass is present yet", () => {
    // The repair path on a machine whose release shipped an empty compass/:
    // nothing to swap out, and cli\ itself may not exist under a bare IX_HOME.
    const compassDir = join(root, "cli", "compass");
    const tarPath = buildCompassTarball("fresh", { "index.html": "<!-- fresh -->" });

    installCompassBundle(tarPath, compassDir, staging(), backup());

    expect(readFileSync(join(compassDir, "index.html"), "utf-8")).toBe("<!-- fresh -->");
  });

  it("leaves the old compass recoverable when the swap tears", () => {
    // swapInStagedTree moves the live compass to backupDir and then renames
    // staging into place. If that second rename fails and its restore fails
    // too, the backup is the only copy left — so the caller must not clear it
    // unconditionally, and the sweep must put it back rather than delete it.
    const compassDir = seedInstalledCompass("<!-- the only copy -->");
    const backupDir = join(root, ".compass-backup-torn");

    // Reproduce the torn state directly: swapInStagedTree got as far as moving
    // the compass aside, then failed.
    renameSync(compassDir, backupDir);
    expect(existsSync(compassDir)).toBe(false);

    // Cleanup must spare the backup while the compass is missing. Driving
    // cleanupCompassSwap rather than re-deriving its condition here: that guard
    // *is* the fix, so a test that restates it would pass either way.
    cleanupCompassSwap(compassDir, join(root, ".compass-staging-torn"), backupDir);
    expect(existsSync(join(backupDir, "index.html"))).toBe(true);

    // And the next run's sweep restores it rather than reclaiming it.
    sweepUpgradeOrphans(root, join(root, "cli"));
    expect(readFileSync(join(compassDir, "index.html"), "utf-8")).toBe("<!-- the only copy -->");
    expect(existsSync(backupDir)).toBe(false);
  });

  it("reclaims compass scratch directories an interrupted run left behind", () => {
    // Nothing swept .compass-staging-* / .compass-backup-* before, so a run
    // killed mid-swap leaked a full copy of the bundle into IX_HOME forever.
    seedInstalledCompass("<!-- installed -->");
    const staging = join(root, ".compass-staging-9999");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "index.html"), "<!-- half-extracted -->");

    sweepUpgradeOrphans(root, join(root, "cli"));

    expect(existsSync(staging)).toBe(false);
    // The installed compass is untouched by the sweep.
    expect(readFileSync(join(root, "cli", "compass", "index.html"), "utf-8")).toBe("<!-- installed -->");
  });

  it("does not leave the staging directory behind on success", () => {
    const compassDir = seedInstalledCompass("<!-- old -->");
    const tarPath = buildCompassTarball("clean", { "index.html": "<!-- new -->" });

    installCompassBundle(tarPath, compassDir, staging(), backup());

    // The swap renames staging onto compassDir, so nothing should survive at
    // either scratch path — these sit in IX_HOME next to the CLI's own
    // .cli-staging-*, and a leaked copy of the bundle stays there forever.
    expect(existsSync(staging())).toBe(false);
    expect(existsSync(backup())).toBe(false);
  });
});
