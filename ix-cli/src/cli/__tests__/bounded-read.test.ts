import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { readRepoFile } from "../bounded-read.js";

/**
 * `readRepoFile` is the one guard standing between ingestion and a file whose
 * path AND contents the scanned repository chose. Every case below is a way a
 * repo can name something that is not the small text file the caller expects.
 */
describe("readRepoFile", () => {
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
    expect(readRepoFile(root, p)).toBe('{ "name": "reads-fine" }');
  });

  it("refuses a file whose reported size is over the cap", () => {
    const p = nodePath.join(root, "big.json");
    fs.writeFileSync(p, "x".repeat(4096));
    expect(readRepoFile(root, p, 1024)).toBeNull();
    // ...and the same file is fine under a cap that admits it, so it is the cap
    // doing the work rather than anything else about the file.
    expect(readRepoFile(root, p, 8192)).not.toBeNull();
  });

  it("refuses a directory", () => {
    const p = nodePath.join(root, "adir");
    fs.mkdirSync(p, { recursive: true });
    expect(readRepoFile(root, p)).toBeNull();
  });

  it("refuses a file that does not exist", () => {
    expect(readRepoFile(root, nodePath.join(root, "absent.json"))).toBeNull();
  });

  /**
   * The case the outer size check cannot catch, and the reason the read is
   * capped separately.
   *
   * A `/proc` entry is a REGULAR file — `isFile()` is true — that reports size
   * 0 while holding kilobytes. `fs.readFileSync(handle)` re-stats, sees 0, and
   * falls back to reading 8 KB chunks until EOF with no limit, so a guard built
   * only from `fstat().size` admits the whole file. Remove the cap inside
   * `readCapped` and this goes green while nothing else in the suite moves.
   */
  it.skipIf(process.platform !== "linux")(
    "refuses a size-0 regular file whose contents exceed the cap",
    () => {
      // Present on every Linux, stable, and comfortably over 100 bytes.
      expect(fs.statSync("/proc/meminfo").isFile()).toBe(true);
      expect(fs.statSync("/proc/meminfo").size).toBe(0);
      expect(readRepoFile("/proc", "/proc/meminfo", 100)).toBeNull();
      // A cap it does fit under still reads, so the refusal above is the cap.
      expect(readRepoFile("/proc", "/proc/meminfo", 1024 * 1024)).toContain("MemTotal");
    },
  );

  // POSIX only: creating a symlink on Windows needs privileges the runner does
  // not have, and /dev/zero has no Windows equivalent.
  describe.skipIf(process.platform === "win32")("symlinks", () => {
    it("refuses a file symlinked outside the root", () => {
      const outside = nodePath.join(os.tmpdir(), `ix-outside-${process.pid}.txt`);
      fs.writeFileSync(outside, "SECRET");
      const inside = nodePath.join(root, "escapes.json");
      fs.symlinkSync(outside, inside);
      try {
        expect(readRepoFile(root, inside)).toBeNull();
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });

    it("still reads when the ROOT itself is reached through a symlink", () => {
      // Resolving the file but not the root would reject every read on macOS
      // (/var -> /private/var), on a network home, or in a pnpm workspace whose
      // package directory is a link. No CI runner here has a symlinked root, so
      // nothing else would notice.
      const realRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ix-realroot-"));
      const linkedRoot = nodePath.join(os.tmpdir(), `ix-linkedroot-${process.pid}`);
      fs.writeFileSync(nodePath.join(realRoot, "package.json"), '{ "name": "via-link" }');
      fs.symlinkSync(realRoot, linkedRoot, "dir");
      try {
        expect(readRepoFile(linkedRoot, nodePath.join(linkedRoot, "package.json"))).toContain(
          "via-link",
        );
      } finally {
        fs.rmSync(linkedRoot, { force: true });
        fs.rmSync(realRoot, { recursive: true, force: true });
      }
    });

    it("refuses a character device, rather than reading it forever", () => {
      const dev = nodePath.join(root, "zero.json");
      fs.symlinkSync("/dev/zero", dev);
      // The assertion that matters is that this returns at all: an unguarded
      // read of /dev/zero does not throw and does not finish, it consumes
      // memory until the process dies.
      const started = Date.now();
      expect(readRepoFile(root, dev)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
