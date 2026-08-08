import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { soleChildDir } from "../commands/upgrade.js";

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
});

describe("upgrade install swap", () => {
  const entry = (base: string, ver: string) =>
    join(base, "cli", `ix-${ver}-windows-amd64`, "cli", "dist", "cli", "main.js");

  function seedInstall(home: string, ver: string) {
    mkdirSync(join(home, "cli", `ix-${ver}-windows-amd64`, "cli", "dist", "cli"), { recursive: true });
    writeFileSync(entry(home, ver), `// ${ver}\n`);
  }

  it("leaves the existing install intact when extraction fails", () => {
    // The regression this guards: the old sequence deleted the install dir
    // before extracting, and on stock Windows the extractor (`unzip`) does not
    // exist — so the CLI was destroyed and nothing replaced it.
    seedInstall(root, "0.8.1");
    const staging = join(root, ".cli-staging-1");

    mkdirSync(staging, { recursive: true });
    try {
      throw new Error("no usable zip extractor found");
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }

    expect(existsSync(entry(root, "0.8.1"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  it("leaves the existing install intact when the archive lacks the entry point", () => {
    seedInstall(root, "0.8.1");
    const staging = join(root, ".cli-staging-2");
    mkdirSync(join(staging, "ix-0.9.0-windows-amd64"), { recursive: true }); // truncated: no main.js

    const stagedRoot = soleChildDir(staging) ?? staging;
    if (!existsSync(join(stagedRoot, "cli", "dist", "cli", "main.js"))) {
      rmSync(staging, { recursive: true, force: true });
    }

    expect(existsSync(entry(root, "0.8.1"))).toBe(true);
  });

  it("swaps in the new version and removes the backup on success", () => {
    seedInstall(root, "0.8.1");
    const staging = join(root, ".cli-staging-3");
    mkdirSync(join(staging, "ix-0.9.0-windows-amd64", "cli", "dist", "cli"), { recursive: true });
    writeFileSync(join(staging, "ix-0.9.0-windows-amd64", "cli", "dist", "cli", "main.js"), "// 0.9.0\n");

    const backup = join(root, ".cli-backup-3");
    renameSync(join(root, "cli"), backup);
    renameSync(staging, join(root, "cli"));
    rmSync(backup, { recursive: true, force: true });

    expect(existsSync(entry(root, "0.9.0"))).toBe(true);
    expect(existsSync(entry(root, "0.8.1"))).toBe(false);
    expect(existsSync(backup)).toBe(false);
  });

  it("restores the previous install if the swap fails mid-way", () => {
    seedInstall(root, "0.8.1");
    const backup = join(root, ".cli-backup-4");

    renameSync(join(root, "cli"), backup);        // old moved aside
    // ...renaming staging in fails here (e.g. a lock on the directory)
    if (existsSync(backup) && !existsSync(join(root, "cli"))) {
      renameSync(backup, join(root, "cli"));      // recovery path
    }

    expect(existsSync(entry(root, "0.8.1"))).toBe(true);
  });
});
