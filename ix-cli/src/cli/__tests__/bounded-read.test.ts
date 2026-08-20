import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { readBoundedFile, readCapped } from "../bounded-read.js";

/**
 * `readBoundedFile` stands between ingestion and a file whose path AND contents
 * the scanned repository chose. Every case below is a way a repo can name
 * something that is not the small text file the caller expects.
 */
describe("readBoundedFile", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-bounded-"));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads an ordinary file", () => {
    const p = nodePath.join(root, "plain.json");
    fs.writeFileSync(p, '{ "name": "reads-fine" }');
    expect(readBoundedFile(p)).toBe('{ "name": "reads-fine" }');
  });

  it("refuses a file whose reported size is over the cap", () => {
    const p = nodePath.join(root, "big.json");
    fs.writeFileSync(p, "x".repeat(4096));
    expect(readBoundedFile(p, { maxBytes: 1024 })).toBeNull();
    // ...and the same file is fine under a cap that admits it, so it is the cap
    // doing the work rather than anything else about the file.
    expect(readBoundedFile(p, { maxBytes: 8192 })).not.toBeNull();
  });

  it("refuses a directory", () => {
    const p = nodePath.join(root, "adir");
    fs.mkdirSync(p, { recursive: true });
    expect(readBoundedFile(p)).toBeNull();
  });

  it("refuses a file that does not exist", () => {
    expect(readBoundedFile(nodePath.join(root, "absent.json"))).toBeNull();
  });

  it("refuses when the caller's accept check says no, and reads when it says yes", () => {
    const p = nodePath.join(root, "gated.json");
    fs.writeFileSync(p, "gated");
    expect(readBoundedFile(p, { accept: () => false })).toBeNull();
    expect(readBoundedFile(p, { accept: () => true })).toBe("gated");
  });

  it("hands accept the stats of the file it actually opened", () => {
    const p = nodePath.join(root, "stats.json");
    fs.writeFileSync(p, "12345");
    const real = fs.statSync(p);
    let seen: fs.Stats | null = null;
    readBoundedFile(p, {
      accept: (stats) => {
        seen = stats;
        return true;
      },
    });
    // Same inode as the path names, so a caller can tie a resolved path back to
    // the handle rather than to a name that may have been swapped underneath.
    expect(seen!.ino).toBe(real.ino);
    expect(seen!.dev).toBe(real.dev);
    expect(seen!.size).toBe(5);
  });
});

/**
 * The cap lives in the READ, not in the fstat, because `fs.readFileSync(handle)`
 * re-stats and reads that size instead. Pinning `readCapped` directly is the
 * only way to assert that on every platform: the wiring can only be caught
 * where a size-0 regular file exists, which is Linux alone.
 */
describe("readCapped", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-capped-"));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const withHandle = <T>(p: string, fn: (fd: number) => T): T => {
    const fd = fs.openSync(p, "r");
    try {
      return fn(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  it("refuses a handle holding more than the cap", () => {
    const p = nodePath.join(root, "over.txt");
    fs.writeFileSync(p, "x".repeat(4096));
    expect(withHandle(p, (fd) => readCapped(fd, 1024))).toBeNull();
    expect(withHandle(p, (fd) => readCapped(fd, 8192))).toHaveLength(4096);
  });

  it("admits a file exactly at the cap and refuses one byte more", () => {
    const at = nodePath.join(root, "at.txt");
    fs.writeFileSync(at, "y".repeat(100));
    expect(withHandle(at, (fd) => readCapped(fd, 100))).toHaveLength(100);
    expect(withHandle(at, (fd) => readCapped(fd, 99))).toBeNull();
  });

  it("reads a file that spans several chunks, without corrupting a split character", () => {
    // A 2-byte character straddling the 64 KiB chunk boundary: decoding per
    // chunk instead of after the concat would turn it into replacement chars.
    const p = nodePath.join(root, "multibyte.txt");
    const head = "a".repeat(64 * 1024 - 1);
    fs.writeFileSync(p, head + "é" + "b".repeat(10), "utf8");
    const out = withHandle(p, (fd) => readCapped(fd, 1024 * 1024));
    expect(out).toBe(head + "é" + "b".repeat(10));
  });

  it("returns empty string for an empty file", () => {
    const p = nodePath.join(root, "empty.txt");
    fs.writeFileSync(p, "");
    expect(withHandle(p, (fd) => readCapped(fd, 1024))).toBe("");
  });
});

/**
 * The case the fstat size check cannot catch, and the reason the read is capped
 * separately. A `/proc` entry is a REGULAR file — `isFile()` true — that reports
 * size 0 while holding kilobytes, so a guard built only from `fstat().size`
 * admits the whole file.
 */
describe.skipIf(process.platform !== "linux")("size-0 regular files", () => {
  it("refuses one whose contents exceed the cap", (ctx) => {
    // Not every /proc is the kernel's: lxcfs and gVisor overlays report a real
    // size, and there the premise of this test simply does not hold. Skip
    // explicitly rather than assert, and never pass silently.
    let stats: fs.Stats;
    try {
      stats = fs.statSync("/proc/meminfo");
    } catch {
      return ctx.skip("no /proc/meminfo on this runner");
    }
    if (!stats.isFile() || stats.size !== 0) {
      return ctx.skip("/proc/meminfo is not a size-0 regular file here");
    }
    expect(readBoundedFile("/proc/meminfo", { maxBytes: 100 })).toBeNull();
    // A cap it does fit under still reads, so the refusal above is the cap.
    expect(readBoundedFile("/proc/meminfo")).toContain("MemTotal");
  });
});

// POSIX only: creating a symlink on Windows needs privileges the runner does
// not have, and /dev/zero has no Windows equivalent.
describe.skipIf(process.platform === "win32")("character devices", () => {
  it("refuses one reached through a symlink, rather than reading it forever", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-dev-"));
    const dev = nodePath.join(dir, "zero.json");
    fs.symlinkSync("/dev/zero", dev);
    try {
      // The assertion that matters is that this returns at all: an unguarded
      // read of /dev/zero does not throw and does not finish, it consumes
      // memory until the process dies.
      const started = Date.now();
      expect(readBoundedFile(dev)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
