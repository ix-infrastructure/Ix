// Bounded reads of repository-controlled files (Ix#465).
//
// Ingestion opens files whose *paths and contents the scanned repository
// chooses*: build manifests (`package.json`, `Cargo.toml`, `go.mod`, ...) and
// TypeScript configs. Both are read while the resolver and the system map are
// built, which happens before ingestion's own size gate, so they need their
// own — and the guard has to survive a repo that is hostile rather than merely
// large.
//
// This module is the one place that guard lives. It previously existed twice,
// in `ts-module-resolution.ts` and `system.ts`, which is how the two defects
// below came to be fixed in one copy and not the other.

import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * How much of a repository-controlled file is worth reading, in bytes.
 *
 * Mirrors `MAX_FILE_BYTES` in `ingest.ts`. A `package.json` or a `tsconfig.json`
 * past this is not one anybody wrote, and parsing one is how a 64 MB file takes
 * the process out with an uncatchable OOM.
 */
export const MAX_REPO_FILE_BYTES = 1024 * 1024;

/**
 * Lexical containment: `candidate` names a path under `root`.
 *
 * Not sufficient on its own — see {@link openedWithinRoot} — but it is the
 * right check for a path that has not been opened yet.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), candidate);
  // Compare path *segments*: a bare `..startsWith` also rejects a legitimate
  // sibling directory whose name merely begins with dots, e.g. `..shared/`.
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

/**
 * True when the file we are *holding open* lives inside `root`.
 *
 * The lexical check in {@link isWithinRoot} cannot see through a symlinked
 * file: every segment of `./pkg/package.json` is inside the root by path
 * arithmetic even when `package.json` points somewhere else entirely. Only the
 * resolved path shows that, so resolve it and re-check.
 *
 * Resolving the name a second time reopens the question of whether it still
 * denotes the file we hold, so the resolved path is confirmed to be the same
 * inode as the open handle. Without that, swapping the symlink between the open
 * and the resolve would let an outside file be read under an inside name.
 * (`ino` is 0 on filesystems that do not report one — chiefly some Windows
 * configurations — where this degrades to the plain resolved-path check.)
 *
 * The ROOT is resolved too, and that is not symmetry for its own sake: a
 * resolved file compared against an unresolved root rejects every file whenever
 * the root is itself reached through a link — macOS `/var` -> `/private/var`, a
 * home directory on a network mount, a `~/code` symlink, or a pnpm workspace
 * whose package directory is a symlink. That would silently switch manifest and
 * tsconfig reading off for those users, and no CI runner here has a symlinked
 * root to notice it.
 */
function openedWithinRoot(root: string, filePath: string, opened: fs.Stats): boolean {
  try {
    const resolved = fs.realpathSync(filePath);
    const viaResolved = fs.statSync(resolved);
    if (viaResolved.dev !== opened.dev || viaResolved.ino !== opened.ino) return false;
    let resolvedRoot: string;
    try {
      resolvedRoot = fs.realpathSync(root);
    } catch {
      resolvedRoot = root; // unreadable root: fall back to the lexical check
    }
    return isWithinRoot(resolvedRoot, resolved);
  } catch {
    return false;
  }
}

/**
 * Read at most `maxBytes` from an open handle; null when the file holds more.
 *
 * `fs.readFileSync(handle)` cannot be used here, even behind an fstat size
 * check, because it re-stats the handle and reads *that* size instead:
 *
 * - a file that grows between the check and the read is read at its new size.
 *   Measured: an fstat that saw 50 bytes followed by a `readFileSync` on the
 *   same handle that returned 550;
 * - a regular file reporting size 0 makes it fall back to reading 8 KB chunks
 *   until EOF with no limit at all. `isFile()` is true and `size` is 0 for
 *   every `/proc` and `/sys` entry, and for size-0 regular files on some FUSE
 *   and network mounts.
 *
 * So the outer size check bounds nothing by itself. Reading the handle here is
 * what makes the cap bind.
 *
 * Refuses rather than truncates: half a manifest is neither valid JSON nor a
 * trustworthy `name = "..."`, and a silent truncation is a worse answer than
 * none.
 */
function readCapped(handle: number, maxBytes: number): string | null {
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
 * Read a repository-controlled file under `root`, bounded, or null.
 *
 * Open once and ask the handle:
 *
 * - `O_NONBLOCK` so opening a FIFO returns instead of waiting for a writer.
 *   It is the one case a guard placed after the open cannot cover, because
 *   without it the open never returns. Undefined on Windows, where `|` with
 *   undefined degrades to a plain read — and Windows has no FIFO to open this
 *   way.
 * - `fstat` on the handle rather than `stat` on the path, so the checks and the
 *   read observe the same inode (CodeQL js/file-system-race).
 * - `openSync` follows symlinks, so fstat describes the *target*. `isFile()`
 *   refuses a device, a FIFO and a directory — neither of which a size check
 *   catches, since `/dev/zero` and a FIFO both report size 0.
 * - containment, so a manifest symlinked to `~/.aws/credentials` is refused
 *   rather than read into the graph under the repository's own name.
 * - the read itself is capped; see {@link readCapped} for why the size check
 *   above does not do that on its own.
 */
export function readRepoFile(
  root: string,
  filePath: string,
  maxBytes: number = MAX_REPO_FILE_BYTES,
): string | null {
  try {
    const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stats = fs.fstatSync(handle);
      if (!stats.isFile() || stats.size > maxBytes) return null;
      if (!openedWithinRoot(root, filePath, stats)) return null;
      return readCapped(handle, maxBytes);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}
