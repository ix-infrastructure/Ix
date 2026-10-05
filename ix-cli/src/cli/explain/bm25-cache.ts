// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * One index per workspace root, replaced when HEAD moves.
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

interface Bm25Index {
  v: number;
  /** `TOKENIZER_FINGERPRINT` when built. */
  tok: string;
  root: string;
  head: string;
  maxBytes: number;
  /** Clean files that were scored, and each one's length in words. */
  paths: string[];
  lengths: number[];
  /** Each scored file's git blob id, so a later HEAD reuses it while unchanged. */
  blobs: string[];
  /** Clean files that were not scored (too large or unreadable at HEAD). */
  skipped: string[];
  skippedBlobs: string[];
  /** Every word, to a flat list of [document index, count] pairs. */
  postings: Record<string, number[]>;
}

/** What the working tree is, as far as the index is concerned. */
export interface GitState {
  head: string;
  /** Tracked paths (relative to the root, as `git ls-files` prints them) that differ from HEAD. */
  dirty: ReadonlySet<string>;
  /** Each path's blob id at HEAD, when known. */
  blobs?: ReadonlyMap<string, string>;
}

/** Every git call here is bounded: none may hold up `ix context` for long. */
const GIT_TIMEOUT_MS = 5_000;

/** Path of the index for one workspace root, under IX_HOME. */
export function bm25IndexPath(root: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(ixHome(), "cache", `bm25_${key}.json`);
}

/**
 * HEAD and the files that differ from it, or undefined outside a checkout (or
 * on an unborn branch). `--no-optional-locks` because this runs in whatever
 * checkout the user is in, and a read must not rewrite its index file. `-c`
 * because `diff HEAD` reads the index, which runs a core.fsmonitor command the
 * repository's own config names.
 */
export function readGitState(root: string): GitState | undefined {
  try {
    const run = (args: string[]) => execFileSync("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
    ], {
      cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    const head = run(["rev-parse", "--verify", "-q", "HEAD"]).trim();
    if (!head) return undefined;
    // --relative: paths relative to `root`, like `git ls-files` run there.
    // --no-renames: a rename lists both of its paths, not only the new one.
    const dirty = run(["diff", "--name-only", "--relative", "--no-renames", "-z", "HEAD", "--"]);
    // HEAD's blobs, not the index's: a clean file's text is HEAD's, while a
    // staged change the worktree has since reverted leaves a different blob
    // in the index, and reusing counts by that blob after it is committed
    // would score the old text. `<mode> <type> <blob>\t<path>` per entry,
    // relative to (and limited to) the root, as `git ls-files` prints paths.
    const blobs = new Map<string, string>();
    for (const entry of run(["ls-tree", "-r", "-z", head]).split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab > 0) blobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
    }
    return { head, dirty: new Set(dirty.split("\0").filter(Boolean)), blobs };
  } catch {
    return undefined;
  }
}

/**
 * A `planIssue` ranker that reads through the index for `root`. Falls back to
 * plain `bm25Rank` when there is no git state to key it by.
 */
export function cachedBm25Ranker(
  root: string,
  opts: { state?: () => GitState | undefined; indexPath?: string } = {},
): (repo: RepoAccess, files: string[], query: string) => Bm25Hit[] {
  return (repo, files, query) => {
    const readState = opts.state ?? (() => readGitState(root));
    const state = readState();
    if (!state) return bm25Rank(repo, files, query);
    const indexPath = opts.indexPath ?? bm25IndexPath(root);
    const weights = bm25QueryWeights(query);
    const terms = [...weights.keys()];
    const index = loadIndex(indexPath, root);
    if (index && index.head === state.head) {
      return bm25Score(docsFromIndex(index, repo, files, terms, state.dirty), weights);
    }

    // Built for another commit, or not at all. A file whose blob is unchanged
    // since that index keeps its counts; only the rest are read and tokenised
    // again. On a HEAD move that touched a handful of files, that is a
    // handful of reads instead of the whole repository.
    const { docs, built } = buildIndex(repo, files, terms, state, root, index);
    // Only if nothing moved while the files were being read: a file edited in
    // that window would otherwise be stored as HEAD's text.
    const after = readState();
    if (after && after.head === state.head && sameSet(after.dirty, state.dirty)) saveIndex(indexPath, built);
    return bm25Score(docs, weights);
  };
}

function docsFromIndex(
  index: Bm25Index,
  repo: Pick<RepoAccess, "read">,
  files: string[],
  terms: string[],
  dirty: ReadonlySet<string>,
): Map<string, Bm25Doc> {
  const position = new Map(index.paths.map((path, i) => [path, i]));
  const skipped = new Set(index.skipped);
  // Only the query's words, as bm25Rank counts them.
  const tfs: Array<Map<string, number> | undefined> = new Array(index.paths.length);
  for (const term of terms) {
    if (!Object.hasOwn(index.postings, term)) continue;
    const list = index.postings[term];
    for (let k = 0; k < list.length; k += 2) (tfs[list[k]] ??= new Map()).set(term, list[k + 1]);
  }
  const wanted = new Set(terms);
  const docs = new Map<string, Bm25Doc>();
  for (const path of files) {
    if (!dirty.has(path)) {
      const i = position.get(path);
      if (i !== undefined) {
        docs.set(path, { tf: tfs[i] ?? new Map(), length: index.lengths[i] });
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

/** A previous index's per-file counts, inverted from its postings once. */
function countsByFile(index: Bm25Index): Array<Map<string, number>> {
  const counts = index.paths.map(() => new Map<string, number>());
  for (const term of Object.keys(index.postings)) {
    const list = index.postings[term];
    for (let k = 0; k < list.length; k += 2) counts[list[k]]?.set(term, list[k + 1]);
  }
  return counts;
}

function buildIndex(
  repo: Pick<RepoAccess, "read">,
  files: string[],
  terms: string[],
  state: GitState,
  root: string,
  previous?: Bm25Index,
): { docs: Map<string, Bm25Doc>; built: Bm25Index } {
  const reusable = previous && state.blobs ? previous : undefined;
  const prevPosition = new Map((reusable?.paths ?? []).map((path, i) => [path, i]));
  const prevSkipped = new Map((reusable?.skipped ?? []).map((path, i) => [path, reusable!.skippedBlobs[i]]));
  let prevCounts: Array<Map<string, number>> | undefined;
  const built: Bm25Index = {
    v: INDEX_VERSION, tok: TOKENIZER_FINGERPRINT, root, head: state.head, maxBytes: MAX_BM25_BYTES,
    paths: [], lengths: [], blobs: [], skipped: [], skippedBlobs: [],
    // No prototype: `constructor` and `tostring` are words too.
    postings: Object.create(null) as Record<string, number[]>,
  };
  const docs = new Map<string, Bm25Doc>();
  for (const path of files) {
    const clean = !state.dirty.has(path);
    const blob = state.blobs?.get(path) ?? "";
    let full: Bm25Doc | undefined;
    if (reusable && clean && blob) {
      const j = prevPosition.get(path);
      if (j !== undefined && reusable.blobs[j] === blob) {
        prevCounts ??= countsByFile(reusable);
        full = { tf: prevCounts[j], length: reusable.lengths[j] };
      } else if (prevSkipped.get(path) === blob) {
        built.skipped.push(path);
        built.skippedBlobs.push(blob);
        continue;
      }
    }
    full ??= bm25Doc(path, repo.read(path));
    if (!full) {
      if (clean) {
        built.skipped.push(path);
        built.skippedBlobs.push(blob);
      }
      continue;
    }
    if (clean) {
      const i = built.paths.length;
      built.paths.push(path);
      built.lengths.push(full.length);
      built.blobs.push(blob);
      for (const [term, count] of full.tf) (built.postings[term] ??= []).push(i, count);
    }
    const tf = new Map<string, number>();
    for (const term of terms) {
      const count = full.tf.get(term);
      if (count) tf.set(term, count);
    }
    docs.set(path, { tf, length: full.length });
  }
  return { docs, built };
}

function loadIndex(path: string, root: string): Bm25Index | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<Bm25Index>;
    if (data.v !== INDEX_VERSION || data.tok !== TOKENIZER_FINGERPRINT || data.root !== root || data.maxBytes !== MAX_BM25_BYTES) return undefined;
    if (typeof data.head !== "string") return undefined;
    if (!Array.isArray(data.paths) || !Array.isArray(data.lengths) || !Array.isArray(data.skipped)) return undefined;
    if (!Array.isArray(data.blobs) || !Array.isArray(data.skippedBlobs)) return undefined;
    if (data.paths.length !== data.lengths.length || data.paths.length !== data.blobs.length) return undefined;
    if (data.skipped.length !== data.skippedBlobs.length) return undefined;
    if (!data.postings || typeof data.postings !== "object") return undefined;
    return data as Bm25Index;
  } catch {
    return undefined;
  }
}

/** Best-effort: an index that cannot be written only costs the next call a rebuild. */
function saveIndex(path: string, index: Bm25Index): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Via a temp file and rename, so a reader never sees half a file.
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* non-critical */ }
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
