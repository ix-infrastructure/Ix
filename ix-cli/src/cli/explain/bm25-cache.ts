// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { ixHome } from "../ix-home.js";
import {
  bm25Doc,
  bm25QueryWeights,
  bm25Rank,
  bm25Score,
  bm25Tokens,
  MAX_BM25_BYTES,
  type Bm25Doc,
  type Bm25Hit,
} from "./issue.js";
import type { RepoAccess } from "./text-references.js";

/**
 * A term index of the tracked source files, so `ix context --from-issue` does
 * not read and tokenize every one of them on every call.
 *
 * Without it BM25 opens every tracked source file (up to 200 KB each) per
 * issue: measured at 56 ms on the Ix repository and ~400 ms on apache/dubbo
 * (2,427 files), paid again for the next issue against the same checkout.
 *
 * Keyed by the commit, so the index describes the files AS COMMITTED: it is
 * built from the working tree, but only files that match HEAD are stored, and
 * files that differ from HEAD (`git diff HEAD`, staged or not) are always read
 * fresh. Git decides what is dirty, including the racily-clean case a size and
 * mtime check would miss, so a hit scores exactly the text a fresh read would.
 * One index per workspace root. When HEAD moves, `git diff` between the
 * stored commit and HEAD names the files whose blob changed; only those are
 * read again, and the stored index is patched rather than rebuilt.
 *
 * On disk it is one file a call can read in part: a header with the paths,
 * then a sorted word table with each word's offset into the postings, so a
 * call at the stored HEAD reads the header and only the query's words. See
 * {@link StoredIndex}.
 *
 * Scores are bit-identical to `bm25Rank`: the same documents go through the
 * same `bm25Score`. Bump INDEX_VERSION whenever `bm25Tokens` or `bm25Doc`
 * changes what a document is, or a stale index would score the old way.
 */
const INDEX_VERSION = 2;

/**
 * What the tokenizer does to a probe that exercises its rules: case, camel
 * and snake splitting, digits, punctuation, stopwords and short words. Part of
 * the index key, so a change to `bm25Tokens` that shows here invalidates every
 * stored index even if nobody bumps INDEX_VERSION -- an upgrade must never
 * score new queries against an old tokenizer's postings.
 */
const TOKENIZER_PROBE =
  "The saveModel() of get_openai_callback fails: JsonWriter.toJsonTree in src/a-b/C.ts line 42, a to is HTTPServer2";
export const TOKENIZER_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(bm25Tokens(TOKENIZER_PROBE))).digest("hex").slice(0, 16);

/** What the working tree is, as far as the index is concerned. */
export interface GitState {
  head: string;
  /** Tracked paths (relative to the root, as `git ls-files` prints them) that differ from HEAD. */
  dirty: ReadonlySet<string>;
  /** Each path's blob id at HEAD, when known. Read with `git ls-tree` only when the index is written. */
  blobs?: ReadonlyMap<string, string>;
}

/** Every git call here is bounded: none may hold up `ix context` for long. */
const GIT_TIMEOUT_MS = 5_000;

function indexKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/** Path of the index for one workspace root, under IX_HOME. */
export function bm25IndexPath(root: string): string {
  return join(ixHome(), "cache", `bm25_${indexKey(root)}.idx`);
}

/** Where the whole-file JSON index used to live. Never read; removed when the new one is written. */
function legacyIndexPath(root: string): string {
  return join(ixHome(), "cache", `bm25_${indexKey(root)}.json`);
}

/**
 * Runs git in `root`. `--no-optional-locks` because this runs in whatever
 * checkout the user is in, and a read must not rewrite its index file. `-c`
 * because `diff HEAD` reads the index, which runs a core.fsmonitor command the
 * repository's own config names.
 */
function git(root: string, args: string[]): string {
  return execFileSync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
  ], {
    cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * HEAD and the files that differ from it, or undefined outside a checkout (or
 * on an unborn branch).
 */
export function readGitState(root: string): GitState | undefined {
  try {
    const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
    if (!head) return undefined;
    // --relative: paths relative to `root`, like `git ls-files` run there.
    // --no-renames: a rename lists both of its paths, not only the new one.
    const dirty = git(root, ["diff", "--name-only", "--relative", "--no-renames", "-z", "HEAD", "--"]);
    return { head, dirty: new Set(dirty.split("\0").filter(Boolean)) };
  } catch {
    return undefined;
  }
}

/**
 * Each path's blob id at `head`. HEAD's blobs, not the index's: a clean file's
 * text is HEAD's, while a staged change the worktree has since reverted leaves
 * a different blob in the index, and reusing counts by that blob after it is
 * committed would score the old text. `<mode> <type> <blob>\t<path>` per entry,
 * relative to (and limited to) the root, as `git ls-files` prints paths.
 */
function readHeadBlobs(root: string, head: string): Map<string, string> | undefined {
  try {
    const blobs = new Map<string, string>();
    for (const entry of git(root, ["ls-tree", "-r", "-z", head]).split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab > 0) blobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
    }
    return blobs;
  } catch {
    return undefined;
  }
}

/**
 * The paths whose blob differs between two commits, each with its blob at `to`
 * (all zeros when deleted), or undefined when git cannot compare them -- the
 * stored commit was garbage-collected, say. A tree-to-tree diff: it reads
 * neither the worktree nor the index, and `--raw` renders no file text.
 */
function changedBlobs(root: string, from: string, to: string): Map<string, string> | undefined {
  try {
    const out = git(root, [
      "diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", "-z", from, to, "--",
    ]);
    const changed = new Map<string, string>();
    // `:<old mode> <new mode> <old blob> <new blob> <status>` NUL `<path>` NUL, per file.
    const fields = out.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = fields[i].split(" ");
      if (meta.length < 5 || !fields[i + 1]) return undefined;
      changed.set(fields[i + 1], meta[3]);
    }
    return changed;
  } catch {
    return undefined;
  }
}

/** Index writes left for {@link saveBm25Index}, by index path. */
const pendingSaves = new Map<string, () => void>();

/**
 * Writes the indexes that rankers made with `deferSave` left for later. Call
 * it once the answer is out: the write is then not between the user and the
 * output. Never throws; an index that cannot be written only costs the next
 * call the same patch again.
 */
export function saveBm25Index(): void {
  for (const [path, save] of [...pendingSaves]) {
    pendingSaves.delete(path);
    try { save(); } catch { /* best effort */ }
  }
}

/**
 * A `planIssue` ranker that reads through the index for `root`. Falls back to
 * plain `bm25Rank` when there is no git state to key it by. With `deferSave`
 * a new or patched index is written by {@link saveBm25Index}, not before the
 * ranker returns.
 */
export function cachedBm25Ranker(
  root: string,
  opts: { state?: () => GitState | undefined; indexPath?: string; deferSave?: boolean } = {},
): (repo: RepoAccess, files: string[], query: string) => Bm25Hit[] {
  return (repo, files, query) => {
    const readState = opts.state ?? (() => readGitState(root));
    const state = readState();
    if (!state) return bm25Rank(repo, files, query);
    const indexPath = opts.indexPath ?? bm25IndexPath(root);
    const weights = bm25QueryWeights(query);
    const terms = [...weights.keys()];

    let found: { docs: Map<string, Bm25Doc>; next?: NextIndex } | undefined;
    const stored = StoredIndex.open(indexPath, root);
    if (stored) {
      try {
        if (stored.header.head === state.head) {
          found = { docs: docsAtHead(stored, repo, files, terms, state.dirty) };
        } else {
          // Built for another commit. A file whose blob is unchanged since
          // then keeps its counts; only the rest are read and tokenised
          // again. On a HEAD move that touched a handful of files, that is a
          // handful of reads instead of the whole repository.
          const changed = changedBlobs(root, stored.header.head, state.head);
          if (changed) found = collectDocs(repo, files, terms, state, { stored, changed });
        }
      } catch {
        // Truncated or overwritten while it was read: rebuilt below.
        found = undefined;
      } finally {
        stored.close();
      }
    }
    found ??= collectDocs(repo, files, terms, state);

    const next = found.next;
    if (next) {
      const save = () => {
        // Only if nothing moved since the files were read: a file edited in
        // that window would otherwise be stored as HEAD's text.
        const after = readState();
        if (!after || after.head !== state.head || !sameSet(after.dirty, state.dirty)) return;
        let index: Built | undefined;
        try {
          index = next.finish(() => state.blobs ?? readHeadBlobs(root, state.head));
        } catch {
          // The previous index's postings did not decode: drop it, so the
          // next call builds afresh instead of patching it again.
          try { rmSync(indexPath, { force: true }); } catch { /* non-critical */ }
          return;
        }
        if (!index) return;
        if (writeIndex(indexPath, { root, head: state.head }, index) && !opts.indexPath) {
          try { rmSync(legacyIndexPath(root), { force: true }); } catch { /* non-critical */ }
        }
      };
      if (opts.deferSave) pendingSaves.set(indexPath, save);
      else save();
    }
    return bm25Score(found.docs, weights);
  };
}

/** Each query word's count in each stored document that has it, by document. */
function queryCounts(stored: StoredIndex, terms: string[]): Array<Map<string, number> | undefined> {
  const tfs: Array<Map<string, number> | undefined> = new Array(stored.header.docs);
  for (const term of terms) stored.eachPosting(term, (doc, count) => (tfs[doc] ??= new Map()).set(term, count));
  return tfs;
}

/** Restricted to the query's words, as bm25Rank counts them. */
function queryDoc(full: Bm25Doc, terms: string[]): Bm25Doc {
  const tf = new Map<string, number>();
  for (const term of terms) {
    const count = full.tf.get(term);
    if (count) tf.set(term, count);
  }
  return { tf, length: full.length };
}

function docsAtHead(
  stored: StoredIndex,
  repo: Pick<RepoAccess, "read">,
  files: string[],
  terms: string[],
  dirty: ReadonlySet<string>,
): Map<string, Bm25Doc> {
  const position = new Map(stored.paths.map((path, i) => [path, i]));
  const skipped = new Set(stored.skipped);
  const tfs = queryCounts(stored, terms);
  const wanted = new Set(terms);
  const docs = new Map<string, Bm25Doc>();
  for (const path of files) {
    if (!dirty.has(path)) {
      const i = position.get(path);
      if (i !== undefined) {
        docs.set(path, { tf: tfs[i] ?? new Map(), length: stored.length(i) });
        continue;
      }
      if (skipped.has(path)) continue;
    }
    // Dirty, or (should not happen at one HEAD) a file the index never saw.
    const doc = bm25Doc(path, repo.read(path), wanted);
    if (doc) docs.set(path, doc);
  }
  return docs;
}

/**
 * The documents to score, and the index to store for HEAD: the previous one
 * (if any) less the files that changed or left, plus the ones read fresh.
 */
function collectDocs(
  repo: Pick<RepoAccess, "read">,
  files: string[],
  terms: string[],
  state: GitState,
  previous?: { stored: StoredIndex; changed: ReadonlyMap<string, string> },
): { docs: Map<string, Bm25Doc>; next: NextIndex } {
  const prev = previous && Previous.read(previous.stored);
  const changed = previous?.changed;
  const position = new Map((prev?.paths ?? []).map((path, i) => [path, i]));
  const skippedAt = new Map((prev?.skipped ?? []).map((path, i) => [path, i]));
  const tfs = previous ? queryCounts(previous.stored, terms) : [];
  const next = new NextIndex(prev);
  const wanted = new Set(terms);
  const docs = new Map<string, Bm25Doc>();
  for (const path of files) {
    const dirty = state.dirty.has(path);
    if (prev && !changed!.has(path)) {
      // Same blob as when it was stored: the stored counts are HEAD's text,
      // kept even while the worktree differs.
      const i = position.get(path);
      const k = i === undefined ? skippedAt.get(path) : undefined;
      if (i !== undefined) next.keep[i] = 1;
      if (k !== undefined) next.keepSkipped[k] = 1;
      if (!dirty && i !== undefined) {
        docs.set(path, { tf: tfs[i] ?? new Map(), length: prev.lengths[i] });
        continue;
      }
      if (!dirty && k !== undefined) continue;
      if (dirty && (i !== undefined || k !== undefined)) {
        const doc = bm25Doc(path, repo.read(path), wanted);
        if (doc) docs.set(path, doc);
        continue;
      }
    }
    // Changed since the stored index, or never in it.
    if (dirty) {
      const doc = bm25Doc(path, repo.read(path), wanted);
      if (doc) docs.set(path, doc);
      continue;
    }
    const full = bm25Doc(path, repo.read(path));
    const blob = changed?.get(path) ?? state.blobs?.get(path);
    if (!full) {
      next.addSkipped(path, blob);
      continue;
    }
    next.addDoc(path, full, blob);
    docs.set(path, queryDoc(full, terms));
  }
  return { docs, next };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// On disk.

/**
 * Not a version: what tells this file from anything else at the path. The
 * format is new with this name (`.idx`); the JSON index it replaced lived at
 * `.json` and is never read.
 */
const MAGIC = Buffer.from("IXBM25T\n", "latin1");
const PREFIX_BYTES = MAGIC.length + 4;

/**
 * The file's sections, in the order they are written. Everything before
 * `blobs` is read by every call; the rest only when HEAD has moved, or a
 * query word's postings when it is looked up.
 *
 * - paths, skipped, blobs, skippedBlobs: NUL-separated UTF-8 (git paths have no NUL).
 * - lengths: u32 LE per document.
 * - termStarts, postStarts: u32 LE per word plus one, into termText and postings.
 * - termText: the words, sorted by their UTF-8 bytes.
 * - postings: per word, (document - previous document, count) pairs as LEB128
 *   varints, documents ascending; the first previous document is -1.
 */
const SECTIONS = [
  "paths", "lengths", "skipped", "termStarts", "postStarts", "termText", "blobs", "skippedBlobs", "postings",
] as const;
type Section = (typeof SECTIONS)[number];

/** JSON after the magic and its own byte length. */
interface Header {
  v: number;
  /** `TOKENIZER_FINGERPRINT` when built. */
  tok: string;
  root: string;
  head: string;
  maxBytes: number;
  /** Scored files, clean files not scored (too large or unreadable at HEAD), distinct words. */
  docs: number;
  skipped: number;
  terms: number;
  /** Each section's [offset, length] in bytes, from the end of the header. */
  at: Record<Section, [number, number]>;
}

class CorruptIndex extends Error {}

/** Reads exactly `length` bytes at `position`, or throws: a short read is a file cut off. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) throw new CorruptIndex("short read");
    done += n;
  }
  return buf;
}

function splitList(buf: Buffer, count: number): string[] {
  if (count === 0) {
    if (buf.length !== 0) throw new CorruptIndex("list");
    return [];
  }
  const list = buf.toString("utf8").split("\0");
  if (list.length !== count) throw new CorruptIndex("list");
  return list;
}

function isSpan(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && Number.isSafeInteger(x[0]) && Number.isSafeInteger(x[1]) && x[1] >= 0;
}

/**
 * A stored index, opened for reading. Holds the descriptor until `close`, so
 * every read is of the one file that was opened, even if another `ix` renames
 * a new index over it meanwhile.
 */
class StoredIndex {
  readonly paths: string[];
  readonly skipped: string[];

  private constructor(
    private readonly fd: number,
    readonly header: Header,
    /** File offset the section offsets count from. */
    private readonly base: number,
    /** The sections from `paths` up to `blobs`. */
    private readonly front: Buffer,
  ) {
    this.paths = splitList(this.section("paths"), header.docs);
    this.skipped = splitList(this.section("skipped"), header.skipped);
    const { terms, at } = header;
    if (this.termStart(terms) !== at.termText[1] || this.postStart(terms) !== at.postings[1]) {
      throw new CorruptIndex("table");
    }
  }

  /** The index at `path` for `root` by this tokenizer, or undefined when there is none usable. */
  static open(path: string, root: string): StoredIndex | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      if (size < PREFIX_BYTES) return undefined;
      const prefix = readAt(fd, 0, PREFIX_BYTES);
      if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
      const headerBytes = prefix.readUInt32LE(MAGIC.length);
      const base = PREFIX_BYTES + headerBytes;
      if (base > size) return undefined;
      const header = JSON.parse(readAt(fd, PREFIX_BYTES, headerBytes).toString("utf8")) as Partial<Header>;
      if (header.v !== INDEX_VERSION || header.tok !== TOKENIZER_FINGERPRINT || header.root !== root) return undefined;
      if (header.maxBytes !== MAX_BM25_BYTES || typeof header.head !== "string") return undefined;
      const { docs, skipped, terms, at } = header;
      if (!Number.isSafeInteger(docs) || !Number.isSafeInteger(skipped) || !Number.isSafeInteger(terms)) return undefined;
      if (docs! < 0 || skipped! < 0 || terms! < 0 || !at || typeof at !== "object") return undefined;
      // The sections tile the rest of the file exactly, in order: a file cut
      // short, or grown by a concurrent writer, fails here.
      let offset = 0;
      for (const name of SECTIONS) {
        const span = at[name];
        if (!isSpan(span) || span[0] !== offset) return undefined;
        offset += span[1];
      }
      if (base + offset !== size) return undefined;
      if (at.lengths[1] !== docs! * 4) return undefined;
      if (at.termStarts[1] !== (terms! + 1) * 4 || at.postStarts[1] !== (terms! + 1) * 4) return undefined;
      const front = readAt(fd, base, at.blobs[0]);
      const index = new StoredIndex(fd, header as Header, base, front);
      fd = undefined; // the index owns it now
      return index;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  close(): void {
    try { closeSync(this.fd); } catch { /* already closed */ }
  }

  section(name: Section): Buffer {
    const [offset, length] = this.header.at[name];
    if (offset + length <= this.front.length) return this.front.subarray(offset, offset + length);
    return readAt(this.fd, this.base + offset, length);
  }

  /** Words in each document. */
  length(doc: number): number {
    return this.front.readUInt32LE(this.header.at.lengths[0] + doc * 4);
  }

  private termStart(i: number): number {
    return this.front.readUInt32LE(this.header.at.termStarts[0] + i * 4);
  }

  private postStart(i: number): number {
    return this.front.readUInt32LE(this.header.at.postStarts[0] + i * 4);
  }

  /** Position of `term` in the word table, or -1. A binary search over the bytes, with no word decoded. */
  private find(term: string): number {
    const want = Buffer.from(term, "utf8");
    const text = this.header.at.termText[0];
    let lo = 0;
    let hi = this.header.terms - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const start = this.termStart(mid);
      const end = this.termStart(mid + 1);
      if (start > end || end > this.header.at.termText[1]) throw new CorruptIndex("term");
      const c = this.front.compare(want, 0, want.length, text + start, text + end);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Calls `emit` with each document that has `term`, and its count there. Reads only that word's postings. */
  eachPosting(term: string, emit: (doc: number, count: number) => void): void {
    const i = this.find(term);
    if (i < 0) return;
    const start = this.postStart(i);
    const end = this.postStart(i + 1);
    if (start > end || end > this.header.at.postings[1]) throw new CorruptIndex("postings");
    const bytes = readAt(this.fd, this.base + this.header.at.postings[0] + start, end - start);
    decodePostings(bytes, 0, bytes.length, this.header.docs, emit);
  }
}

/** One word's postings: see {@link SECTIONS}. Throws on anything a writer would not have written. */
function decodePostings(
  buf: Buffer, start: number, end: number, docs: number, emit: (doc: number, count: number) => void,
): void {
  let p = start;
  let doc = -1;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (p >= end || scale > 2 ** 28) throw new CorruptIndex("varint");
      const byte = buf[p++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
  };
  while (p < end) {
    const delta = varint();
    const count = varint();
    doc += delta;
    if (delta < 1 || count < 1 || doc >= docs) throw new CorruptIndex("posting");
    emit(doc, count);
  }
}

/** One varint at `at`, and the offset after it. */
function readVarint(buf: Buffer, at: number, end: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  for (let p = at; p < end && scale <= 2 ** 28; p++) {
    value += (buf[p] & 0x7f) * scale;
    if (buf[p] < 0x80) return { value, next: p + 1 };
    scale *= 128;
  }
  throw new CorruptIndex("varint");
}

/** An append-only byte buffer that doubles as it fills. */
class Bytes {
  buf: Buffer;
  n = 0;
  constructor(capacity: number) {
    this.buf = Buffer.allocUnsafe(Math.max(64, capacity));
  }
  private room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const grown = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.n + k));
    this.buf.copy(grown, 0, 0, this.n);
    this.buf = grown;
  }
  varint(value: number): void {
    this.room(5);
    this.n = writeVarint(this.buf, this.n, value);
  }
  copy(from: Buffer, start: number, end: number): void {
    this.room(end - start);
    from.copy(this.buf, this.n, start, end);
    this.n += end - start;
  }
  done(): Buffer {
    return this.buf.subarray(0, this.n);
  }
}

function u32s(values: ArrayLike<number>, count = values.length): Buffer {
  const buf = Buffer.allocUnsafe(count * 4);
  for (let i = 0; i < count; i++) buf.writeUInt32LE(values[i], i * 4);
  return buf;
}

/** Everything of a stored index a patch needs, read in full while the file is open. */
class Previous {
  private constructor(
    readonly paths: string[],
    readonly lengths: Uint32Array,
    readonly blobs: string[],
    readonly skipped: string[],
    readonly skippedBlobs: string[],
    readonly termStarts: Buffer,
    readonly postStarts: Buffer,
    readonly termText: Buffer,
    readonly postings: Buffer,
  ) {}

  static read(stored: StoredIndex): Previous {
    const { docs, skipped } = stored.header;
    const lengths = new Uint32Array(docs);
    for (let i = 0; i < docs; i++) lengths[i] = stored.length(i);
    return new Previous(
      stored.paths, lengths, splitList(stored.section("blobs"), docs),
      stored.skipped, splitList(stored.section("skippedBlobs"), skipped),
      stored.section("termStarts"), stored.section("postStarts"), stored.section("termText"),
      stored.section("postings"),
    );
  }

  get terms(): number {
    return this.termStarts.length / 4 - 1;
  }
}

/**
 * The words of documents read fresh, as flat (word id, count) pairs per
 * document rather than a map of arrays: a cold build of a large repository
 * holds millions of them until it is written.
 */
class FreshPostings {
  /**
   * Word to id. An object, not a Map: its keys are interned copies, while a
   * word the tokenizer cut out of a file can be a slice that keeps the whole
   * file's text alive for as long as the word is held.
   */
  private ids: Record<string, number> = Object.create(null) as Record<string, number>;
  private words = 0;
  private ascii = true;
  private word = new Uint32Array(1024);
  private count = new Uint32Array(1024);
  private n = 0;
  private readonly docStarts: number[] = [0];

  add(tf: ReadonlyMap<string, number>): void {
    if (this.n + tf.size > this.word.length) {
      const capacity = Math.max(Math.ceil(this.word.length * 1.5), this.n + tf.size);
      const word = new Uint32Array(capacity);
      const count = new Uint32Array(capacity);
      word.set(this.word.subarray(0, this.n));
      count.set(this.count.subarray(0, this.n));
      this.word = word;
      this.count = count;
    }
    for (const [term, c] of tf) {
      let id = this.ids[term];
      if (id === undefined) {
        id = this.words++;
        this.ids[term] = id;
        if (this.ascii && !/^[\x00-\x7f]*$/.test(term)) this.ascii = false;
      }
      this.word[this.n] = id;
      this.count[this.n] = c;
      this.n++;
    }
    this.docStarts.push(this.n);
  }

  /**
   * The words sorted by their UTF-8 bytes, as the word table is, and each
   * one's postings encoded as the file stores them, numbering the fresh
   * documents from 0. Once only: it lets go of its pairs as it goes.
   */
  encoded(): { text: Buffer; textStarts: Uint32Array; postStarts: Uint32Array; postings: Buffer } {
    const sorted: string[] = [];
    for (const term in this.ids) sorted.push(term);
    // For ASCII the string order is the byte order; otherwise ask the bytes.
    if (this.ascii) sorted.sort();
    else sorted.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const rank = new Uint32Array(this.words);
    for (let r = 0; r < sorted.length; r++) rank[this.ids[sorted[r]]] = r;
    this.ids = Object.create(null) as Record<string, number>;

    // Two passes over the pairs, documents in order: the bytes each word's
    // postings take, then the postings themselves, each written in place.
    const last = new Int32Array(sorted.length);
    const postStarts = new Uint32Array(sorted.length + 1);
    const pass = (visit: (r: number, delta: number, count: number) => void) => {
      last.fill(-1);
      for (let d = 0; d + 1 < this.docStarts.length; d++) {
        for (let k = this.docStarts[d]; k < this.docStarts[d + 1]; k++) {
          const r = rank[this.word[k]];
          visit(r, d - last[r], this.count[k]);
          last[r] = d;
        }
      }
    };
    pass((r, delta, count) => { postStarts[r + 1] += varintBytes(delta) + varintBytes(count); });
    for (let r = 0; r < sorted.length; r++) postStarts[r + 1] += postStarts[r];
    const postings = Buffer.allocUnsafe(postStarts[sorted.length]);
    const cursor = postStarts.slice(0, sorted.length);
    pass((r, delta, count) => {
      cursor[r] = writeVarint(postings, cursor[r], delta);
      cursor[r] = writeVarint(postings, cursor[r], count);
    });
    this.word = new Uint32Array(0);
    this.count = new Uint32Array(0);

    const text = Buffer.from(sorted.join(""), "utf8");
    const textStarts = new Uint32Array(sorted.length + 1);
    for (let r = 0; r < sorted.length; r++) {
      textStarts[r + 1] = textStarts[r] + (this.ascii ? sorted[r].length : Buffer.byteLength(sorted[r], "utf8"));
    }
    return { text, textStarts, postStarts, postings };
  }
}

function varintBytes(value: number): number {
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : value < 0x200000 ? 3 : value < 0x10000000 ? 4 : 5;
}

/** Writes `value` as a LEB128 varint at `at`; returns the offset after it. */
function writeVarint(buf: Buffer, at: number, value: number): number {
  let v = value >>> 0;
  while (v >= 0x80) {
    buf[at++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  buf[at++] = v;
  return at;
}

/** The sections of an index to write, less its header's identity. */
interface Built {
  paths: string[];
  lengths: number[];
  blobs: string[];
  skipped: string[];
  skippedBlobs: string[];
  terms: number;
  termStarts: Buffer;
  postStarts: Buffer;
  termText: Buffer;
  postings: Buffer;
}

/**
 * The index to store for HEAD, assembled lazily: which documents of the
 * previous index stay, and what was read fresh. `finish` does the merge, so a
 * deferred save also defers the work.
 */
class NextIndex {
  /** 1 for each previous document (and skipped file) that stays. */
  readonly keep: Uint8Array;
  readonly keepSkipped: Uint8Array;
  private readonly fresh = new FreshPostings();
  private readonly freshPaths: string[] = [];
  private readonly freshLengths: number[] = [];
  private readonly freshBlobs: Array<string | undefined> = [];
  private readonly freshSkipped: string[] = [];
  private readonly freshSkippedBlobs: Array<string | undefined> = [];

  constructor(private readonly prev: Previous | undefined) {
    this.keep = new Uint8Array(prev?.paths.length ?? 0);
    this.keepSkipped = new Uint8Array(prev?.skipped.length ?? 0);
  }

  addDoc(path: string, full: Bm25Doc, blob: string | undefined): void {
    this.freshPaths.push(path);
    this.freshLengths.push(full.length);
    this.freshBlobs.push(blob);
    this.fresh.add(full.tf);
  }

  addSkipped(path: string, blob: string | undefined): void {
    this.freshSkipped.push(path);
    this.freshSkippedBlobs.push(blob);
  }

  /** The merged index, or undefined when a fresh file's blob cannot be found. */
  finish(headBlobs: () => ReadonlyMap<string, string> | undefined): Built | undefined {
    let blobs: ReadonlyMap<string, string> | undefined;
    const blobOf = (path: string, known: string | undefined): string | undefined => {
      if (known !== undefined) return known;
      blobs ??= headBlobs();
      return blobs ? blobs.get(path) ?? "" : undefined;
    };
    const out: Built = {
      paths: [], lengths: [], blobs: [], skipped: [], skippedBlobs: [],
      terms: 0, termStarts: Buffer.alloc(0), postStarts: Buffer.alloc(0), termText: Buffer.alloc(0), postings: Buffer.alloc(0),
    };
    const prev = this.prev;
    // Previous documents keep their order, so their postings stay ascending.
    const remap = new Int32Array(this.keep.length).fill(-1);
    for (let i = 0; i < this.keep.length; i++) {
      if (!this.keep[i]) continue;
      remap[i] = out.paths.length;
      out.paths.push(prev!.paths[i]);
      out.lengths.push(prev!.lengths[i]);
      out.blobs.push(prev!.blobs[i]);
    }
    const kept = out.paths.length;
    for (let i = 0; i < this.keepSkipped.length; i++) {
      if (!this.keepSkipped[i]) continue;
      out.skipped.push(prev!.skipped[i]);
      out.skippedBlobs.push(prev!.skippedBlobs[i]);
    }
    for (let f = 0; f < this.freshPaths.length; f++) {
      const blob = blobOf(this.freshPaths[f], this.freshBlobs[f]);
      if (blob === undefined) return undefined;
      out.paths.push(this.freshPaths[f]);
      out.lengths.push(this.freshLengths[f]);
      out.blobs.push(blob);
    }
    for (let f = 0; f < this.freshSkipped.length; f++) {
      const blob = blobOf(this.freshSkipped[f], this.freshSkippedBlobs[f]);
      if (blob === undefined) return undefined;
      out.skipped.push(this.freshSkipped[f]);
      out.skippedBlobs.push(blob);
    }

    // Merge the two sorted word lists. A previous word's postings are
    // re-encoded with the surviving documents renumbered; a fresh word's
    // documents all come after them.
    const fresh = this.fresh.encoded();
    if (!prev) {
      // Nothing to merge: the fresh words are the index.
      out.terms = fresh.postStarts.length - 1;
      out.termStarts = u32s(fresh.textStarts);
      out.postStarts = u32s(fresh.postStarts);
      out.termText = fresh.text;
      out.postings = fresh.postings;
      return out;
    }
    const oldTerms = prev.terms;
    const newTerms = fresh.postStarts.length - 1;
    const termStarts = new Uint32Array(oldTerms + newTerms + 1);
    const postStarts = new Uint32Array(oldTerms + newTerms + 1);
    const text = new Bytes(prev.termText.length + fresh.text.length);
    const postings = new Bytes(prev.postings.length + fresh.postings.length + newTerms);
    let terms = 0;
    let i = 0;
    let j = 0;
    while (i < oldTerms || j < newTerms) {
      let c: number;
      let os = 0;
      let oe = 0;
      if (i < oldTerms) {
        os = prev.termStarts.readUInt32LE(i * 4);
        oe = prev.termStarts.readUInt32LE(i * 4 + 4);
      }
      if (i >= oldTerms) c = 1;
      else if (j >= newTerms) c = -1;
      else c = prev.termText.compare(fresh.text, fresh.textStarts[j], fresh.textStarts[j + 1], os, oe);
      const before = postings.n;
      let last = -1;
      if (c <= 0) {
        decodePostings(prev.postings, prev.postStarts.readUInt32LE(i * 4), prev.postStarts.readUInt32LE(i * 4 + 4),
          prev.paths.length, (doc, count) => {
            const to = remap[doc];
            if (to < 0) return;
            postings.varint(to - last);
            postings.varint(count);
            last = to;
          });
      }
      if (c >= 0) {
        // Fresh documents follow the kept ones. Only the first delta of the
        // word's fresh postings depends on where they start; the rest are
        // copied as they are.
        const start = fresh.postStarts[j];
        const end = fresh.postStarts[j + 1];
        if (kept === 0 && last === -1) postings.copy(fresh.postings, start, end);
        else {
          // The first fresh document is its delta less one (from -1).
          const delta = readVarint(fresh.postings, start, end);
          const count = readVarint(fresh.postings, delta.next, end);
          postings.varint(kept + delta.value - 1 - last);
          postings.varint(count.value);
          postings.copy(fresh.postings, count.next, end);
        }
      }
      if (postings.n > before) {
        if (c <= 0) text.copy(prev.termText, os, oe);
        else text.copy(fresh.text, fresh.textStarts[j], fresh.textStarts[j + 1]);
        terms++;
        termStarts[terms] = text.n;
        postStarts[terms] = postings.n;
      }
      if (c <= 0) i++;
      if (c >= 0) j++;
    }
    if (postings.n > 0xffffffff || text.n > 0xffffffff) return undefined;
    out.terms = terms;
    out.termStarts = u32s(termStarts, terms + 1);
    out.postStarts = u32s(postStarts, terms + 1);
    out.termText = text.done();
    out.postings = postings.done();
    return out;
  }
}

/**
 * Best-effort: an index that cannot be written only costs the next call a
 * rebuild. Via a temp file of this process's own and a rename, so a reader
 * (another `ix`, say a hook of a parallel session) never sees half a file,
 * and of two writers the last rename wins whole.
 */
function writeIndex(path: string, id: { root: string; head: string }, index: Built): boolean {
  const sections: Record<Section, Buffer> = {
    paths: Buffer.from(index.paths.join("\0"), "utf8"),
    lengths: u32s(index.lengths),
    skipped: Buffer.from(index.skipped.join("\0"), "utf8"),
    termStarts: index.termStarts,
    postStarts: index.postStarts,
    termText: index.termText,
    blobs: Buffer.from(index.blobs.join("\0"), "utf8"),
    skippedBlobs: Buffer.from(index.skippedBlobs.join("\0"), "utf8"),
    postings: index.postings,
  };
  const at = {} as Record<Section, [number, number]>;
  let offset = 0;
  for (const name of SECTIONS) {
    at[name] = [offset, sections[name].length];
    offset += sections[name].length;
  }
  const header: Header = {
    v: INDEX_VERSION, tok: TOKENIZER_FINGERPRINT, root: id.root, head: id.head, maxBytes: MAX_BM25_BYTES,
    docs: index.paths.length, skipped: index.skipped.length, terms: index.terms, at,
  };
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt32LE(json.length, MAGIC.length);

  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tmp, "w");
    for (const chunk of [prefix, json, ...SECTIONS.map((name) => sections[name])]) {
      let done = 0;
      while (done < chunk.length) done += writeSync(fd, chunk, done, chunk.length - done);
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return true;
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* non-critical */ }
    try { rmSync(tmp, { force: true }); } catch { /* non-critical */ }
    return false;
  }
}
