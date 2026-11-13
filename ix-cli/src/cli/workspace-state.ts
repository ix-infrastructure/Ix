// Copyright 2026 Ix Infrastructure Inc.

/**
 * How Ix reads and writes its per-project-root state files under IX_HOME
 * (#966). Where they live, and which are cleared together, is
 * `state-paths.ts` (`WORKSPACE_STATE_FILES`).
 *
 * Every file carries a `formatVersion`. A reader accepts its own version and
 * a file with none (version 0: written before versions existed, read with the
 * presence rules that applied then); any other version reads as absent. Every
 * caller already handles an absent file, at the cost of one re-ingest or one
 * recomputation, so a format change is a version bump rather than one more
 * rule about which optional fields are present.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write `contents` to `target` via a temp file and a rename, so a process
 * killed mid-write leaves the previous file rather than a truncated one.
 * Creates the directory. On failure the temp file is removed and the error
 * rethrown; callers decide whether a lost write matters.
 */
export function writeFileAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, target);
  } catch (err) {
    // A failed rename (a locked target on Windows, say) must not leave the
    // temp file behind; one would pile up per failing run.
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Write `data` to `target` as JSON with `formatVersion` first, atomically.
 * Returns the text written. Throws like `writeFileAtomic`.
 */
export function writeStateAtomic(target: string, formatVersion: number, data: object): string {
  // First in the file, and never taken from `data`: a value read back and
  // re-saved must not carry the version it was read with.
  const record: Record<string, unknown> = { formatVersion };
  Object.assign(record, data);
  record.formatVersion = formatVersion;
  const text = JSON.stringify(record);
  writeFileAtomic(target, text);
  return text;
}

/** A parsed state file: its JSON object, the version it declares (0 for none), and its size. */
export interface StateFileContents {
  data: Record<string, unknown>;
  formatVersion: number;
  bytes: number;
}

/**
 * Read and parse `target`, or null when it is missing, malformed, not a JSON
 * object, or declares a version other than `version`. A file without
 * `formatVersion` reads as version 0.
 */
export function readStateFile(target: string, version: number): StateFileContents | null {
  try {
    const text = fs.readFileSync(target, "utf-8");
    const data = JSON.parse(text) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    const declared = record.formatVersion === undefined ? 0 : record.formatVersion;
    if (declared !== 0 && declared !== version) return null;
    return { data: record, formatVersion: declared, bytes: Buffer.byteLength(text) };
  } catch {
    return null;
  }
}

export interface ReadStateOptions<T> {
  /** The version this reader writes; a file with no version is read as 0. */
  version: number;
  /** Turn the parsed object into the caller's value, or null when it does not qualify. */
  validate: (data: Record<string, unknown>, formatVersion: number) => T | null;
}

/** The state in `target`, or null when there is none this reader understands. Never throws. */
export function readState<T>(target: string, { version, validate }: ReadStateOptions<T>): T | null {
  const file = readStateFile(target, version);
  if (file === null) return null;
  try {
    return validate(file.data, file.formatVersion);
  } catch {
    return null;
  }
}
