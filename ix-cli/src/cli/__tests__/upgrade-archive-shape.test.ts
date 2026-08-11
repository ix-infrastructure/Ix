import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  installStagedTree,
  prepareDownloadDir,
  soleChildDir,
  swapInStagedTree,
  sweepUpgradeOrphans,
} from "../commands/upgrade.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ix-upgrade-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// soleChildDir and swapInStagedTree are each correct in isolation; the bug was
// in how the upgrade path combined them. It resolved the staged root to read
// the CLI entry point, then swapped in the *outer* staging directory, so a
// Windows install ended up at cli\ix-<version>-windows-amd64\ — reproducing
// inside cli\ exactly the nesting it had just seen through. COMPASS_DIR and
// findCompassDist read cli\compass and nothing else, so `ix view` was broken on
// every Windows install and broke again on the first upgrade after install.ps1
// started laying the tree down flat.
//
// So these go through installStagedTree, which is where the upgrade path makes
// that choice. Resolving the staged root here and calling swapInStagedTree
// directly would pass against the bug too — the defect was never in either
// helper, only in the line that joined them, and a test that re-derives the
// composition cannot see it.
describe("staged swap, as the upgrade path composes it", () => {
  function seedWindowsZipStaging(home: string, ver: string) {
    const staging = join(home, `.cli-staging-${ver}`);
    const nested = join(staging, `ix-${ver}-windows-amd64`);
    mkdirSync(join(nested, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(nested, "cli", "dist", "cli", "main.js"), `// ${ver}\n`);
    mkdirSync(join(nested, "compass"), { recursive: true });
    writeFileSync(join(nested, "compass", "index.html"), "<!doctype html>\n");
    return staging;
  }

  it("leaves compass where the CLI looks for it, given a nested Windows zip", () => {
    const installDir = join(root, "cli");
    const staging = seedWindowsZipStaging(root, "0.9.0");

    installStagedTree(installDir, staging, join(root, ".cli-backup-1"), true);

    // COMPASS_DIR / findCompassDist read exactly this path.
    expect(existsSync(join(installDir, "compass", "index.html"))).toBe(true);
    expect(existsSync(join(installDir, "cli", "dist", "cli", "main.js"))).toBe(true);
    // The nesting must not survive into the install.
    expect(existsSync(join(installDir, "ix-0.9.0-windows-amd64"))).toBe(false);
  });

  it("clears the staging husk the inner move leaves behind", () => {
    const installDir = join(root, "cli");
    const staging = seedWindowsZipStaging(root, "0.9.0");

    installStagedTree(installDir, staging, join(root, ".cli-backup-husk"), true);

    // Moving the inner directory out leaves the outer one standing. Left in
    // place it is a `.cli-staging-<pid>` that only the next run's sweep
    // reclaims, and on a reused pid that sweep is what the *next* upgrade
    // trips over.
    expect(existsSync(staging)).toBe(false);
  });

  it("keeps the launcher pointing at the install root once the tree is flat", () => {
    const installDir = join(root, "cli");
    const staging = seedWindowsZipStaging(root, "0.9.0");
    installStagedTree(installDir, staging, join(root, ".cli-backup-2"), true);

    // refreshLaunchers derives the shim target this way: a flat install has
    // several directories, so there is no sole child and the shim resolves to
    // %~dp0..\cli\ix.cmd — the form install.ps1 now writes.
    expect(soleChildDir(installDir)).toBeNull();
  });

  it("is unchanged for a POSIX tarball, already flattened by --strip-components", () => {
    const installDir = join(root, "cli");
    const staging = join(root, ".cli-staging-posix");
    mkdirSync(join(staging, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(staging, "cli", "dist", "cli", "main.js"), "// posix\n");
    mkdirSync(join(staging, "compass"), { recursive: true });
    writeFileSync(join(staging, "compass", "index.html"), "<!doctype html>\n");

    // isWindows false: the staged root is the staging directory itself, so the
    // tree is installed whole and there is no husk to clear.
    installStagedTree(installDir, staging, join(root, ".cli-backup-3"), false);

    expect(existsSync(join(installDir, "compass", "index.html"))).toBe(true);
    expect(existsSync(join(installDir, "cli", "dist", "cli", "main.js"))).toBe(true);
  });

  it("installs a Windows tree that is already flat without re-nesting it", () => {
    // install.ps1 now lays the tree down flat, so the *next* upgrade sees a
    // Windows staging directory with no sole child. soleChildDir returns null
    // and the fallback has to install the staging directory itself.
    const installDir = join(root, "cli");
    const staging = join(root, ".cli-staging-flat");
    mkdirSync(join(staging, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(staging, "cli", "dist", "cli", "main.js"), "// flat\n");
    mkdirSync(join(staging, "compass"), { recursive: true });
    writeFileSync(join(staging, "compass", "index.html"), "<!doctype html>\n");

    installStagedTree(installDir, staging, join(root, ".cli-backup-4"), true);

    expect(existsSync(join(installDir, "compass", "index.html"))).toBe(true);
    expect(existsSync(join(installDir, "cli", "dist", "cli", "main.js"))).toBe(true);
  });
});

describe("soleChildDir", () => {
  it("finds the single nested directory a Windows release zip extracts to", () => {
    // Windows zips wrap everything in ix-<version>-<platform>/; the launcher
    // shim has to point inside it, so the name is read back rather than assumed.
    const nested = join(root, "ix-0.9.0-windows-amd64");
    mkdirSync(nested, { recursive: true });
    expect(soleChildDir(root)).toBe(nested);
  });

  it("ignores loose files beside the directory", () => {
    const nested = join(root, "ix-0.9.0-windows-amd64");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "README.txt"), "x");
    expect(soleChildDir(root)).toBe(nested);
  });

  it("returns null when the layout is already flat (POSIX tarball)", () => {
    // --strip-components=1 leaves several top-level dirs, so there is no single
    // child to descend into and the caller must use the directory as-is.
    mkdirSync(join(root, "cli"), { recursive: true });
    mkdirSync(join(root, "core-ingestion"), { recursive: true });
    mkdirSync(join(root, "compass"), { recursive: true });
    expect(soleChildDir(root)).toBeNull();
  });

  it("returns null for an empty or missing directory", () => {
    expect(soleChildDir(root)).toBeNull();
    expect(soleChildDir(join(root, "does-not-exist"))).toBeNull();
  });

  it("propagates a read failure instead of reporting it as a flat layout", () => {
    // Swallowing anything other than "not there" would surface downstream as
    // "the release archive did not contain the expected entry point", pointing
    // the user at GitHub for what is a fault on their own machine. A plain file
    // gives a deterministic non-ENOENT readdir failure (ENOTDIR) on every OS.
    const notADir = join(root, "regular-file");
    writeFileSync(notADir, "x");
    expect(() => soleChildDir(notADir)).toThrow();
  });
});

describe("swapInStagedTree", () => {
  const entry = (base: string, ver: string) =>
    join(base, "cli", `ix-${ver}-windows-amd64`, "cli", "dist", "cli", "main.js");

  function seedInstall(home: string, ver: string) {
    mkdirSync(join(home, "cli", `ix-${ver}-windows-amd64`, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(entry(home, ver), `// ${ver}\n`);
  }

  function seedStaging(home: string, name: string, ver: string) {
    const staging = join(home, name);
    mkdirSync(join(staging, `ix-${ver}-windows-amd64`, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(staging, `ix-${ver}-windows-amd64`, "cli", "dist", "cli", "main.js"), `// ${ver}\n`);
    return staging;
  }

  it("swaps in the new version and removes the backup on success", () => {
    seedInstall(root, "0.8.1");
    const staging = seedStaging(root, ".cli-staging-1", "0.9.0");
    const backup = join(root, ".cli-backup-1");

    swapInStagedTree(join(root, "cli"), staging, backup);

    expect(existsSync(entry(root, "0.9.0"))).toBe(true);
    expect(existsSync(entry(root, "0.8.1"))).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it("installs cleanly when there is no previous install to move aside", () => {
    const staging = seedStaging(root, ".cli-staging-2", "0.9.0");
    swapInStagedTree(join(root, "cli"), staging, join(root, ".cli-backup-2"));
    expect(existsSync(entry(root, "0.9.0"))).toBe(true);
  });

  it("restores the previous install when the staged tree cannot be moved in", () => {
    // The regression this guards: if the second rename fails, the old install
    // has already been moved aside and must be put back rather than left gone.
    seedInstall(root, "0.8.1");
    const backup = join(root, ".cli-backup-3");
    const missingStaging = join(root, ".cli-staging-does-not-exist");

    expect(() => swapInStagedTree(join(root, "cli"), missingStaging, backup)).toThrow();

    expect(existsSync(entry(root, "0.8.1"))).toBe(true);
    expect(existsSync(backup)).toBe(false);
  });

  it("completes even when a previous run left a backup directory behind", () => {
    // The swap is complete once the rename lands; clearing the previous tree is
    // housekeeping and must never fail the upgrade. Aborting there would skip
    // the launcher refresh and leave the shim aimed at a directory that no
    // longer exists — the brick this whole path exists to prevent.
    seedInstall(root, "0.8.1");
    const staging = seedStaging(root, ".cli-staging-4", "0.9.0");
    const backup = join(root, ".cli-backup-4");
    mkdirSync(join(backup, "stale", "junk"), { recursive: true });
    writeFileSync(join(backup, "stale", "junk", "leftover.js"), "// from an earlier failed run\n");

    expect(() => swapInStagedTree(join(root, "cli"), staging, backup)).not.toThrow();

    expect(existsSync(entry(root, "0.9.0"))).toBe(true);
    expect(existsSync(entry(root, "0.8.1"))).toBe(false);
    expect(existsSync(backup)).toBe(false);
  });
});

describe("sweepUpgradeOrphans", () => {
  it("restores the install when a previous run died between the two renames", () => {
    // Ctrl-C in that window leaves no ~/.ix/cli at all, so the user cannot run
    // `ix upgrade` to repair it — the next run has to put it back itself.
    const installDir = join(root, "cli");
    const backup = join(root, ".cli-backup-999");
    mkdirSync(join(backup, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(backup, "cli", "dist", "cli", "main.js"), "// 0.8.1\n");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(installDir, "cli", "dist", "cli", "main.js"))).toBe(true);
    expect(existsSync(backup)).toBe(false);
  });

  it("reclaims staging and backup leftovers without touching a healthy install", () => {
    const installDir = join(root, "cli");
    mkdirSync(join(installDir, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "// live\n");
    mkdirSync(join(root, ".cli-staging-111"), { recursive: true });
    mkdirSync(join(root, ".cli-backup-222"), { recursive: true });

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(root, ".cli-staging-111"))).toBe(false);
    expect(existsSync(join(root, ".cli-backup-222"))).toBe(false);
    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// live\n");
  });

  // install.ps1 downloads to `.cli-staging-<pid>.zip` and tees the compose pull
  // output to `.cli-staging-pull-<pid>.log`, both inside IX_HOME, because
  // Windows hands it a TEMP path in 8.3 short form whenever the profile
  // contains a space and PowerShell's provider cannot resolve one. Moving them
  // out of TEMP also moved them out from under the OS's own cleanup, so the
  // installer now leans on this sweep to be the thing that reclaims them after
  // a run that was killed before its own delete. They are files rather than
  // directories, which the prefix match above had never been given.
  it("reclaims the installer's leftover scratch files, not just directories", () => {
    const installDir = join(root, "cli");
    mkdirSync(join(installDir, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "// live\n");
    writeFileSync(join(root, ".cli-staging-333.zip"), "PK");
    writeFileSync(join(root, ".cli-staging-pull-333.log"), "pulling...\n");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(root, ".cli-staging-333.zip"))).toBe(false);
    expect(existsSync(join(root, ".cli-staging-pull-333.log"))).toBe(false);
    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// live\n");
  });

  // The zip must not be named `.cli-backup-*`: that prefix is a recovery
  // candidate, so a leftover would be renamed *over* ~/.ix/cli on the next
  // upgrade and replace the install with a zip file. This pins the reason for
  // the name install.ps1 actually uses.
  it("does not treat a stray file as an install worth recovering", () => {
    const installDir = join(root, "cli");
    writeFileSync(join(root, ".cli-staging-444.zip"), "PK");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(installDir)).toBe(false);
  });

  it("is a no-op when IX_HOME does not exist yet", () => {
    expect(() => sweepUpgradeOrphans(join(root, "nope"), join(root, "nope", "cli"))).not.toThrow();
  });

  // `ix upgrade` downloads into `.cli-download-*` / `.compass-download-*` under
  // IX_HOME rather than os.tmpdir(), which on Windows is TEMP verbatim and is
  // the path #349 died on. Leaving TEMP also left the OS's own cleanup, so a
  // run killed mid-download would park a multi-MB archive in ~/.ix forever
  // unless this sweep reclaims it.
  it("reclaims an interrupted download's scratch directory", () => {
    const installDir = join(root, "cli");
    mkdirSync(join(installDir, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "// live\n");
    mkdirSync(join(root, ".cli-download-abc123"), { recursive: true });
    writeFileSync(join(root, ".cli-download-abc123", "ix-0.9.2-linux-amd64.tar.gz"), "gz");
    mkdirSync(join(root, ".compass-download-def456"), { recursive: true });

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(root, ".cli-download-abc123"))).toBe(false);
    expect(existsSync(join(root, ".compass-download-def456"))).toBe(false);
    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// live\n");
  });

  // The counterpart to the `.cli-backup-` note above, and the reason the sweep
  // call had to move above the download rather than staying between the
  // download and the extract: a download directory must never be a recovery
  // candidate, or an interrupted upgrade would rename an archive over ~/.ix/cli.
  it("does not treat a download directory as an install worth recovering", () => {
    const installDir = join(root, "cli");
    mkdirSync(join(root, ".cli-download-abc123"), { recursive: true });
    writeFileSync(join(root, ".cli-download-abc123", "ix-0.9.2-linux-amd64.tar.gz"), "gz");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(installDir)).toBe(false);
  });

  /**
   * cleanupCompassSwap tests `index.html` rather than a bare existsSync, and
   * says why: a `compass/` holding only a `.version` is a real state, and a
   * bare existsSync "would call that 'back in place' and drop a backup the
   * caller had just told the user to go and rescue".
   *
   * recover() used the bare test, so the two disagreed on exactly that state —
   * it declined to restore, and the loop below then deleted the only working
   * bundle. Preserved by the swap's cleanup, destroyed by the sweep. Hoisting
   * the sweep above the download made it fire on runs that install nothing, so
   * an offline `ix upgrade` was enough to lose the compass permanently.
   */
  it("restores the compass over a husk instead of deleting the backup", () => {
    const installDir = join(root, "cli");
    // A torn swap: compass/ exists but holds only .version — index.html never
    // arrived — while the backup holds the real bundle.
    mkdirSync(join(installDir, "compass"), { recursive: true });
    writeFileSync(join(installDir, "compass", ".version"), "0.3.0\n");
    mkdirSync(join(root, ".compass-backup-1234"), { recursive: true });
    writeFileSync(join(root, ".compass-backup-1234", "index.html"), "<!-- real -->");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(installDir, "compass", "index.html"))).toBe(true);
    expect(readFileSync(join(installDir, "compass", "index.html"), "utf-8")).toBe("<!-- real -->");
    expect(existsSync(join(root, ".compass-backup-1234"))).toBe(false);
  });

  it("leaves a genuinely intact compass alone", () => {
    // The other side of the same test: a real bundle is never replaced by a
    // backup, and the backup is still reclaimed.
    const installDir = join(root, "cli");
    mkdirSync(join(installDir, "compass"), { recursive: true });
    writeFileSync(join(installDir, "compass", "index.html"), "<!-- live -->");
    mkdirSync(join(root, ".compass-backup-1234"), { recursive: true });
    writeFileSync(join(root, ".compass-backup-1234", "index.html"), "<!-- stale -->");

    sweepUpgradeOrphans(root, installDir);

    expect(readFileSync(join(installDir, "compass", "index.html"), "utf-8")).toBe("<!-- live -->");
    expect(existsSync(join(root, ".compass-backup-1234"))).toBe(false);
  });

  it("restores the CLI over a tree with no entry point", () => {
    // Same rule for the install: a cli/ that cannot start is not worth keeping
    // a backup from.
    const installDir = join(root, "cli");
    mkdirSync(join(installDir, "cli", "dist"), { recursive: true });
    mkdirSync(join(root, ".cli-backup-1234", "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(root, ".cli-backup-1234", "cli", "dist", "cli", "main.js"), "// real\n");

    sweepUpgradeOrphans(root, installDir);

    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// real\n");
  });

  /**
   * Moving the scratch under IX_HOME put it inside the sweep's reach for the
   * whole 300s curl timeout. A second `ix upgrade` — a second terminal, or
   * bootstrap.sh re-running it when compass is missing — would delete the first
   * run's archive mid-download; on POSIX the unlink is silent and curl still
   * exits 0, so the victim fails at the extract on a download it completed.
   */
  it("does not reclaim a download directory owned by a live process", () => {
    const installDir = join(root, "cli");
    // process.pid is by definition live — this stands in for the other run.
    const live = join(root, `.cli-download-${process.pid}-aaaaaa`);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "ix-0.9.2-linux-amd64.tar.gz"), "in flight");

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(join(live, "ix-0.9.2-linux-amd64.tar.gz"))).toBe(true);
  });

  it("still reclaims a download directory whose process is gone", () => {
    const installDir = join(root, "cli");
    // PID 2^22 is above every platform's pid_max, so it cannot be running.
    const dead = join(root, ".cli-download-4194304-bbbbbb");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "ix-0.9.2-linux-amd64.tar.gz"), "abandoned");
    // And the pre-pid naming, which must stay collectable.
    mkdirSync(join(root, ".compass-download-cccccc"), { recursive: true });

    sweepUpgradeOrphans(root, installDir);

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(root, ".compass-download-cccccc"))).toBe(false);
  });
});

/**
 * The ordering that #349's fix turns on, and the one thing about it no test
 * reached while it was written inline in the command action: the sweep must run
 * BEFORE the download scratch is created. Once the sweep reclaims
 * `.cli-download-*`, running it afterwards deletes the archive the extract is
 * about to read — breaking every upgrade on every platform, not just the
 * Windows one. Both call sites go through this function so the order cannot
 * drift back apart.
 */
describe("prepareDownloadDir", () => {
  it("reclaims an earlier run's scratch but keeps the one it just made", () => {
    const installDir = join(root, "cli");
    mkdirSync(join(root, ".cli-download-stale1"), { recursive: true });
    writeFileSync(join(root, ".cli-download-stale1", "ix-0.9.1-linux-amd64.tar.gz"), "old");

    const dir = prepareDownloadDir(root, installDir, ".cli-download-");

    expect(existsSync(join(root, ".cli-download-stale1"))).toBe(false);
    // Swept after the mkdtemp instead of before, this directory is gone too and
    // the download that follows writes an archive nothing will extract.
    expect(existsSync(dir)).toBe(true);

    writeFileSync(join(dir, "ix-0.9.2-linux-amd64.tar.gz"), "gz");
    expect(existsSync(join(dir, "ix-0.9.2-linux-amd64.tar.gz"))).toBe(true);
  });

  it("puts an interrupted install back before downloading anything", () => {
    // The other half of sweeping first: the recovery happens even if the
    // download then fails, which the old position could not do.
    const installDir = join(root, "cli");
    mkdirSync(join(root, ".cli-backup-999", "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(root, ".cli-backup-999", "cli", "dist", "cli", "main.js"), "// prev\n");

    const dir = prepareDownloadDir(root, installDir, ".cli-download-");

    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// prev\n");
    expect(existsSync(dir)).toBe(true);
  });

  it("creates IX_HOME when a manual install never did", () => {
    const ixHome = join(root, "fresh");
    const dir = prepareDownloadDir(ixHome, join(ixHome, "cli"), ".compass-download-");
    expect(existsSync(dir)).toBe(true);
  });
});

/**
 * #349's reporter is on a profile at `C:\Users\Win 10`, and their confirmed
 * workaround was pointing TEMP at a space-free path.
 *
 * That matters more since the scratch moved into IX_HOME (#392). The old TEMP
 * path was `C:\Users\WIN10~1\AppData\Local\Temp\...` — an 8.3 alias, which
 * never contains a space. The new one is `C:\Users\Win 10\.ix\...`, which does.
 * So if that failure is space-driven rather than short-path-driven, the move
 * put a space onto the upgrade path where there previously wasn't one.
 *
 * The mechanism is still unreproduced and this cannot settle it — it runs on
 * whatever platform CI is on, and the suspected fault is a Windows path
 * provider. What it does do is prove our own code does not assume a space-free
 * IX_HOME, so that when the reporter tries again the remaining suspects are
 * outside this repo. Nothing else in the suite passes a path with a space.
 */
describe("an IX_HOME containing a space", () => {
  let spaced: string;

  beforeEach(() => {
    spaced = join(root, "Win 10", ".ix");
    mkdirSync(spaced, { recursive: true });
  });

  it("prepares a download directory inside it", () => {
    const dir = prepareDownloadDir(spaced, join(spaced, "cli"), ".cli-download-");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("Win 10");
    // The pid marker has to survive the join, or the sweep cannot tell a live
    // download from an abandoned one.
    expect(dir).toMatch(/\.cli-download-\d+-/);
  });

  it("creates IX_HOME when a manual install never did", () => {
    const missing = join(root, "Some Where", ".ix");
    const dir = prepareDownloadDir(missing, join(missing, "cli"), ".cli-download-");
    expect(existsSync(dir)).toBe(true);
  });

  it("sweeps its own orphans", () => {
    const installDir = join(spaced, "cli");
    mkdirSync(join(installDir, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "// live\n");
    // A pid that is not running. Not 1 — that is init, always alive, and the
    // sweep would correctly skip it as an in-flight download by another
    // process. (It did, the first time this was written.)
    const deadPid = 0x7ffffff0;
    mkdirSync(join(spaced, `.cli-download-${deadPid}-abc`), { recursive: true });

    sweepUpgradeOrphans(spaced, installDir);

    expect(existsSync(join(spaced, `.cli-download-${deadPid}-abc`))).toBe(false);
    expect(readFileSync(join(installDir, "cli", "dist", "cli", "main.js"), "utf-8")).toBe("// live\n");
  });

  it("restores an interrupted install into it", () => {
    const installDir = join(spaced, "cli");
    const backup = join(spaced, ".cli-backup-999");
    mkdirSync(join(backup, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(backup, "cli", "dist", "cli", "main.js"), "// 0.9.4\n");

    sweepUpgradeOrphans(spaced, installDir);

    expect(existsSync(join(installDir, "cli", "dist", "cli", "main.js"))).toBe(true);
  });
});
