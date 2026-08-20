// Bounded reads of repository-controlled files (Ix#465).
//
// Ingestion opens files whose paths AND contents the scanned repository
// chooses: build manifests (`package.json`, `Cargo.toml`, `go.mod`, ...) and
// TypeScript configs. Both are read while the system map and the module
// resolver are built, which happens before ingestion's own size gate, so they
// need their own — and the guard has to survive a repo that is hostile rather
// than merely large.
//
// This module is only the READ. Containment is the caller's, via `accept`:
// what counts as "inside" differs per caller, and getting it wrong silently
// deletes input rather than failing, so it does not belong behind a default.

import * as fs from "node:fs";

/**
 * How much of a repository-controlled file is worth reading, in bytes.
 *
 * Mirrors `MAX_FILE_BYTES` in `ingest.ts`. A `package.json` or a
 * `tsconfig.json` past this is not one anybody wrote, and parsing one is how a
 * 64 MB file takes the process out with an uncatchable OOM.
 */
const MAX_REPO_FILE_BYTES = 1024 * 1024;

/**
 * Read at most `maxBytes` from an open handle; null when the file holds more.
 *
 * `fs.readFileSync(handle)` cannot be used here, even behind an fstat size
 * check, because it re-stats the handle and reads *that* size instead:
 *
 * - a file that grows between the check and the read is read at its new size.
 *   Measured: an fstat that saw 50 bytes, followed by a `readFileSync` on the
 *   same handle that returned 550;
 * - a regular file reporting size 0 makes it fall back to reading 8 KB chunks
 *   until EOF with no limit at all. `isFile()` is true and `size` is 0 for
 *   every `/proc` and `/sys` entry, and for size-0 regular files on some FUSE
 *   and network mounts.
 *
 * So the fstat size check bounds nothing on its own. Reading the handle here is
 * what makes the cap bind.
 *
 * Refuses rather than truncates: half a manifest is neither valid JSON nor a
 * trustworthy `name = "..."`, and a silent truncation is a worse answer than
 * none. The per-chunk copy is required — the scratch buffer is reused — and the
 * decode happens after the concat, so a multi-byte character straddling a chunk
 * boundary round-trips intact.
 *
 * @internal Exported only so the cap can be pinned directly on every platform.
 * Not a reader: it does no open, no type check and no containment, so nothing
 * outside this module should call it. {@link readBoundedFile} is the entry
 * point.
 */
export function readCapped(handle: number, maxBytes: number): string | null {
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const bytes = fs.readSync(handle, chunk, 0, chunk.length, null);
    if (bytes === 0) break;
    total += bytes;
    if (total > maxBytes) return null;
    chunks.push(Buffer.from(chunk.subarray(0, bytes)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Read a repository-controlled file, bounded and type-checked, or null.
 *
 * Open once and ask the handle:
 *
 * - `O_NONBLOCK` so opening a FIFO returns instead of waiting for a writer. It
 *   is the one case a guard placed after the open cannot cover, because without
 *   it the open never returns. Undefined on Windows, where `|` with undefined
 *   degrades to a plain read — and Windows has no FIFO to open this way.
 * - `fstat` on the handle rather than `stat` on the path, so the checks and the
 *   read observe the same inode (CodeQL js/file-system-race).
 * - `openSync` follows symlinks, so fstat describes the *target*. `isFile()`
 *   refuses a device, a FIFO and a directory — none of which a size check
 *   catches, since `/dev/zero` and a FIFO both report size 0.
 * - `accept`, if given, is the caller's own check on that same open file. It
 *   runs before any content is read, and is where a containment rule belongs:
 *   it needs the `fs.Stats` of the handle to tie a resolved path back to the
 *   file actually held.
 * - the read itself is capped; see {@link readCapped} for why the size check
 *   does not do that on its own.
 */
export function readBoundedFile(
  filePath: string,
  opts: { maxBytes?: number; accept?: (opened: fs.Stats) => boolean } = {},
): string | null {
  const { maxBytes = MAX_REPO_FILE_BYTES, accept } = opts;
  try {
    const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stats = fs.fstatSync(handle);
      if (!stats.isFile() || stats.size > maxBytes) return null;
      if (accept && !accept(stats)) return null;
      return readCapped(handle, maxBytes);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}
