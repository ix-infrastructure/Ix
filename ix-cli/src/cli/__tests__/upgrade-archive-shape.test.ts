import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { soleChildDir, swapInStagedTree, sweepUpgradeOrphans } from "../commands/upgrade.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ix-upgrade-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

  it("is a no-op when IX_HOME does not exist yet", () => {
    expect(() => sweepUpgradeOrphans(join(root, "nope"), join(root, "nope", "cli"))).not.toThrow();
  });
});
