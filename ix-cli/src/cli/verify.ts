// Copyright 2026 Ix Infrastructure Inc.

/**
 * `ix verify`: re-parse a sample of files and compare what the parser says
 * they hold against the nodes the graph stores for them.
 *
 * Everything else that reports on the graph's health (`ix status`, `ix doctor`,
 * graph-health.ts) reads counts or mtimes, so a graph whose nodes quietly stop
 * matching the source -- nodes an earlier ingest left behind, a lost write --
 * passes every one of them. This is the only check that looks at the nodes
 * themselves.
 *
 * Node-level only. Each file is read from disk, parsed and built into the same
 * patch ingest would build (no edges), and its UpsertNode ops are the expected
 * set. The stored set comes from `/v1/list` scoped reads, one per node kind the
 * workspace holds (`/v1/stats` byKind, plus the parse's own kinds), filtered to
 * rows whose `provenance.sourceUri` is exactly that file.
 *
 * What the source hash can and cannot say. `/v1/source-hashes` answers with
 * the sourceHash of the file's newest stored patch (highest rev). A patch the
 * backend answers `Idempotent` writes no patch, so after a revert or a restore
 * (F-01) the newest patch is still the edit in between and its hash is not the
 * disk hash. A hash mismatch alone therefore cannot tell "edited since the last
 * map" from "reverted, and the revert was not applied". Verify tells them apart
 * only with the ingest baseline's `replayedFiles`, the files the last map saw
 * answered `Idempotent`:
 *  - stored hash == disk hash, nodes differ: diverged. The graph claims these
 *    bytes and holds other nodes (left-behind nodes, a lost write).
 *  - stored hash != disk hash, the file is in `replayedFiles` and unchanged
 *    since that map, nodes differ: diverged (F-01, `replayed_not_applied`).
 *  - stored hash != disk hash otherwise: stale (`ix map`). That includes an
 *    F-01 revert the baseline does not list (a baseline from an older CLI):
 *    verify cannot see it, and does not claim to.
 *
 * TODO(CL-24, F-03/F-06): edge comparison. Edges -- CONTAINS and every
 * cross-file edge -- are deliberately not compared, and no partial edge check
 * is made: what a file's edges should resolve to depends on the rest of the
 * graph, and the ingest-lane fixes F-03/F-06 change exactly that. Until they
 * land, an edge comparison would report ingest's known gaps as divergence.
 * Externals (`attrs.external`) are left out on both sides for the same reason:
 * they exist only because of an edge.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import type { IxClient } from "../client/api.js";
import type { GraphNode } from "../client/types.js";
import { mapLimit } from "../client/request-memo.js";
import { canonicalWorkspacePath, findWorkspaceForCwd, verifyRecordPath } from "./config.js";
import { extractorChanged, loadIngestBaseline, type IngestBaseline } from "./ingest-baseline.js";
import { fileIdentity } from "./system.js";
import { normalizePathSeparators } from "./path-match.js";
import { readBoundedBytes } from "./bounded-read.js";
import { GRAPH_MAP_FIX, GRAPH_REBUILD_FIX } from "./graph-health.js";
import { isBackendUnreachable } from "./errors.js";
import { loadIngestionModules } from "./commands/ingestion-loader.js";

export const DEFAULT_VERIFY_SAMPLE = 20;
export const DEFAULT_VERIFY_SEED = 24;
/** Rows per `/v1/list` read. A file with this many of one kind is not judged. */
export const VERIFY_LIST_LIMIT = 5000;
/**
 * Kinds always read. The kinds `/v1/stats` reports for the workspace are read
 * too (that list is what makes an extra node of any kind visible); these cover
 * a stats read that fails or lags.
 */
export const VERIFY_DEFAULT_KINDS: readonly string[] = ["file", "function", "method", "class", "interface", "module", "constant", "variable", "trait", "enum", "type"];
const VERIFY_CONCURRENCY = 4;
/** Ingest skips files over this many bytes (`MAX_FILE_BYTES` in ingest.ts), so verify does too. */
const VERIFY_MAX_FILE_BYTES = 1024 * 1024;
/** Bound on the `/v1/stats` read that lists the workspace's kinds. */
const VERIFY_STATS_TIMEOUT_MS = 15_000;

export type VerifyFileState = "clean" | "stale" | "diverged" | "unverified";
/**
 * The graph's verdict from its sampled files. `stale` (no file diverged, at
 * least one changed since the last ingest) is not divergence, and not a pass
 * either: the sample cannot vouch for files whose graph is behind the disk.
 */
export type VerifyGraphVerdict = "clean" | "stale" | "diverged" | "unverified";
/** Every graph verdict, for validating a saved record. */
export const VERIFY_GRAPH_VERDICTS: readonly VerifyGraphVerdict[] = ["clean", "stale", "diverged", "unverified"];

export interface VerifyNode {
  kind: string;
  name: string;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface VerifyNodeRef {
  id: string;
  kind: string;
  name: string;
}

export interface VerifyNodeChange {
  id: string;
  field: "kind" | "name" | "lineStart" | "lineEnd";
  expected: string | number | null;
  stored: string | number | null;
}

export interface NodeDiff {
  missing: VerifyNodeRef[];
  extra: VerifyNodeRef[];
  changed: VerifyNodeChange[];
}

export interface VerifyFileResult {
  path: string;
  state: VerifyFileState;
  /** Why a file is unverified or stale; absent when clean or diverged. */
  reason?: string;
  expectedNodes: number;
  storedNodes: number;
  missing: VerifyNodeRef[];
  extra: VerifyNodeRef[];
  changed: VerifyNodeChange[];
}

export interface VerifyCounts {
  files: number;
  clean: number;
  stale: number;
  diverged: number;
  unverified: number;
}

export interface VerifyReport {
  at: string;
  root: string;
  lastIngestAt: string | null;
  graph: VerifyGraphVerdict;
  /** Why the graph is unverified; absent otherwise. */
  reason?: string;
  /** What to run, or null when there is nothing to fix. */
  fix: string | null;
  sample: number;
  seed: number;
  counts: VerifyCounts;
  files: VerifyFileResult[];
  /**
   * True when `budgetMs` ran out first: `files` holds only the files judged
   * in time. Absent on a run that finished.
   */
  partial?: boolean;
}

/** What `ix status` reads back: the last whole-root verify, without per-file detail. */
export interface VerifyRecord {
  root: string;
  at: string;
  lastIngestAt: string | null;
  graph: VerifyGraphVerdict;
  files: number;
  stale: number;
  diverged: number;
  unverified: number;
  divergedFiles: string[];
  fix: string | null;
}

// ── Sampling ─────────────────────────────────────────────────────────────

/** A small seeded PRNG, so the same seed picks the same files. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A baseline key (absolute, or already workspace-relative) as a POSIX workspace-relative path. */
export function baselineRelPath(root: string, key: string): string | null {
  const rel = nodePath.isAbsolute(key) ? nodePath.relative(root, key) : key;
  const posix = normalizePathSeparators(rel);
  if (posix === "" || posix === ".." || posix.startsWith("../") || nodePath.isAbsolute(posix)) return null;
  return posix;
}

export interface PickVerifyOptions {
  sample: number;
  seed: number;
  /** Workspace-relative paths the caller named. Always picked, first. */
  explicit?: readonly string[];
  /** Whether a grammar handles this path; files it rejects are never sampled. */
  supported?: (rel: string) => boolean;
}

/**
 * Which files to verify, in order: the ones named, then the ones the last run
 * could not get applied (`replayedFiles`, the F-01 suspects), then the most
 * recently changed up to half the sample, then a seeded shuffle of the rest.
 * Files whose parse timed out are not in the graph by design and are not
 * sampled; a named one is still picked, and `runVerify` reports it unverified
 * (`parse_timed_out`) without parsing it.
 */
export function pickVerifyFiles(
  root: string,
  baseline: Pick<IngestBaseline, "files" | "replayedFiles" | "parseTimeouts">,
  { sample, seed, explicit = [], supported = () => true }: PickVerifyOptions,
): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    picked.push(rel);
  };
  for (const rel of explicit) add(normalizePathSeparators(rel));

  const timedOut = new Set(baseline.parseTimeouts.map(normalizePathSeparators));
  const eligible = (rel: string): boolean => !timedOut.has(rel) && !seen.has(rel) && supported(rel);

  const known = new Map<string, number>();
  for (const [key, mtime] of baseline.files) {
    const rel = baselineRelPath(root, key);
    if (rel !== null) known.set(rel, mtime);
  }

  for (const rel of baseline.replayedFiles.map(normalizePathSeparators)) {
    if (picked.length >= sample) return picked;
    if (eligible(rel)) add(rel);
  }

  const candidates = [...known.keys()].filter(eligible).sort();
  const newestFirst = [...candidates].sort((a, b) => (known.get(b)! - known.get(a)!) || a.localeCompare(b));
  const recentTarget = Math.min(sample, picked.length + Math.ceil(sample / 2));
  for (const rel of newestFirst) {
    if (picked.length >= recentTarget) break;
    add(rel);
  }

  const rest = candidates.filter((rel) => !seen.has(rel));
  const random = mulberry32(seed);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const rel of rest) {
    if (picked.length >= sample) break;
    add(rel);
  }
  return picked;
}

// ── Node sets ────────────────────────────────────────────────────────────

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Kinds left out on both sides: chunks (`ix map` strips them) and edge-born externals. */
function comparable(kind: unknown, attrs: Record<string, unknown> | undefined): boolean {
  return typeof kind === "string" && kind !== "chunk" && attrs?.external !== true;
}

function lineSpan(attrs: Record<string, unknown> | undefined): { lineStart: number | null; lineEnd: number | null } {
  return {
    lineStart: numberOrNull(attrs?.line_start ?? attrs?.start_line),
    lineEnd: numberOrNull(attrs?.line_end ?? attrs?.end_line),
  };
}

/** The nodes a freshly built patch upserts, keyed by id. */
export function expectedNodes(patch: { ops: ReadonlyArray<Record<string, unknown>> }): Map<string, VerifyNode> {
  const out = new Map<string, VerifyNode>();
  for (const op of patch.ops) {
    if (op.type !== "UpsertNode" || typeof op.id !== "string") continue;
    const attrs = (op.attrs ?? {}) as Record<string, unknown>;
    if (!comparable(op.kind, attrs) || out.has(op.id)) continue;
    out.set(op.id, { kind: op.kind as string, name: String(op.name ?? ""), ...lineSpan(attrs) });
  }
  return out;
}

/**
 * The stored nodes of one file, keyed by id. The backend's `scope` is a
 * substring match, so `src/a.ts` also brings back `lib/src/a.ts` and
 * `src/a.ts.bak`; only an exact source path counts.
 */
export function storedNodes(rows: ReadonlyArray<Record<string, unknown>>, rel: string): Map<string, VerifyNode> {
  const want = normalizePathSeparators(rel);
  const out = new Map<string, VerifyNode>();
  for (const row of rows) {
    const prov = (row.provenance ?? {}) as Record<string, unknown>;
    const uri = prov.sourceUri ?? prov.source_uri;
    if (typeof uri !== "string" || normalizePathSeparators(uri) !== want) continue;
    if (typeof row.id !== "string" || (row.deletedRev !== undefined && row.deletedRev !== null)) continue;
    const attrs = (row.attrs ?? {}) as Record<string, unknown>;
    if (!comparable(row.kind, attrs) || out.has(row.id)) continue;
    out.set(row.id, { kind: row.kind as string, name: String(row.name ?? ""), ...lineSpan(attrs) });
  }
  return out;
}

const ref = (id: string, node: VerifyNode): VerifyNodeRef => ({ id, kind: node.kind, name: node.name });

export function diffNodes(expected: Map<string, VerifyNode>, stored: Map<string, VerifyNode>): NodeDiff {
  const missing: VerifyNodeRef[] = [];
  const extra: VerifyNodeRef[] = [];
  const changed: VerifyNodeChange[] = [];
  for (const [id, exp] of expected) {
    const got = stored.get(id);
    if (!got) { missing.push(ref(id, exp)); continue; }
    for (const field of ["kind", "name", "lineStart", "lineEnd"] as const) {
      if (exp[field] !== got[field]) changed.push({ id, field, expected: exp[field], stored: got[field] });
    }
  }
  for (const [id, got] of stored) {
    if (!expected.has(id)) extra.push(ref(id, got));
  }
  return { missing, extra, changed };
}

const isEmptyDiff = (diff: NodeDiff): boolean =>
  diff.missing.length === 0 && diff.extra.length === 0 && diff.changed.length === 0;

/**
 * One file's verdict.
 *
 * `storedHash` is the backend's source hash for the file: undefined when it has
 * none, null when the lookup itself failed. `diff` is null when there was
 * nothing to compare (no parse, a failed read of the stored nodes).
 *
 *  - stale: the stored hash is not the disk hash and nothing says why. Usually
 *    an edit since the last map (`ix map` fixes it); see the module comment
 *    for the F-01 revert this cannot be told apart from.
 *  - diverged: the nodes disagree with bytes the graph should hold: the stored
 *    hash equals the disk hash, or `replayed` (the last map sent these bytes,
 *    the backend answered Idempotent, so the stored hash is the edit in
 *    between) and the file has not changed since.
 *  - unverified: no judgement was possible. A file with no stored hash and no
 *    stored nodes is here too: ingest skips some files on purpose (empty,
 *    minified-looking), and that is not something a re-map would change.
 */
export function classifyFile(
  diskHash: string,
  storedHash: string | null | undefined,
  diff: NodeDiff | null,
  truncated: boolean,
  storedCount = 0,
  replayed = false,
): { state: VerifyFileState; reason?: string } {
  if (truncated) return { state: "unverified", reason: "truncated" };
  if (!diff) return { state: "unverified", reason: "no_comparison" };
  if (storedHash === undefined && storedCount === 0) return { state: "unverified", reason: "not_in_graph" };
  // F-01: the last ingest sent these very bytes and the backend answered
  // Idempotent (it holds a patch with this id) and wrote no patch, so the
  // newest stored patch, and the hash, are the edit in between. Not fixed by
  // `ix map`, which sends the same patch id again.
  if (replayed && storedHash !== null && storedHash !== diskHash && !isEmptyDiff(diff)) {
    return { state: "diverged", reason: "replayed_not_applied" };
  }
  if (storedHash !== null && storedHash !== diskHash) return { state: "stale", reason: "changed_since_ingest" };
  if (isEmptyDiff(diff)) return { state: "clean" };
  if (storedHash === null) return { state: "unverified", reason: "hash_unknown" };
  return { state: "diverged" };
}

export function countStates(files: readonly VerifyFileResult[]): VerifyCounts {
  const counts: VerifyCounts = { files: files.length, clean: 0, stale: 0, diverged: 0, unverified: 0 };
  for (const f of files) counts[f.state]++;
  return counts;
}

/**
 * The graph's verdict from its files, first match wins:
 *  - diverged: any file diverged (stale files alone are not divergence);
 *  - unverified (`no_files`): nothing was sampled;
 *  - stale: any file changed since the last ingest. Even beside clean files:
 *    a stale file's nodes could not be compared with its source, so the
 *    sample does not show the graph matches it. `ix map` is the fix;
 *  - unverified (`no_file_verified`): no file was judged clean;
 *  - clean: at least one file verified clean and none stale or diverged.
 *    Unverified files beside them (an unsupported language, a file ingest
 *    skips) do not stop a clean verdict; they are counted.
 */
export function graphVerdict(counts: VerifyCounts): { graph: VerifyGraphVerdict; fix: string | null; reason?: string } {
  if (counts.diverged > 0) return { graph: "diverged", fix: GRAPH_REBUILD_FIX };
  if (counts.files === 0) return { graph: "unverified", fix: null, reason: "no_files" };
  if (counts.stale > 0) return { graph: "stale", fix: GRAPH_MAP_FIX };
  if (counts.clean === 0) return { graph: "unverified", fix: null, reason: "no_file_verified" };
  return { graph: "clean", fix: null };
}

// ── Record ───────────────────────────────────────────────────────────────

export function recordFromReport(report: VerifyReport): VerifyRecord {
  return {
    root: report.root,
    at: report.at,
    lastIngestAt: report.lastIngestAt,
    graph: report.graph,
    files: report.counts.files,
    stale: report.counts.stale,
    diverged: report.counts.diverged,
    unverified: report.counts.unverified,
    divergedFiles: report.files.filter((f) => f.state === "diverged").map((f) => f.path),
    fix: report.fix,
  };
}

/** The last verify for this root, or null. Never throws. */
export function loadVerifyRecord(projectRoot: string): VerifyRecord | null {
  try {
    const data = JSON.parse(fs.readFileSync(verifyRecordPath(projectRoot), "utf-8")) as Partial<VerifyRecord>;
    if (typeof data.root !== "string" || typeof data.at !== "string") return null;
    // Canonical on both sides: `--root .`, a trailing slash or a symlinked
    // path names the same root as the canonical one `ix verify` saved.
    if (canonicalWorkspacePath(data.root) !== canonicalWorkspacePath(projectRoot)) return null;
    if (!VERIFY_GRAPH_VERDICTS.includes(data.graph as VerifyGraphVerdict)) return null;
    const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
    return {
      root: data.root,
      at: data.at,
      lastIngestAt: typeof data.lastIngestAt === "string" ? data.lastIngestAt : null,
      graph: data.graph as VerifyGraphVerdict,
      files: count(data.files),
      stale: count(data.stale),
      diverged: count(data.diverged),
      unverified: count(data.unverified),
      divergedFiles: Array.isArray(data.divergedFiles) ? data.divergedFiles.filter((p): p is string => typeof p === "string") : [],
      fix: typeof data.fix === "string" ? data.fix : null,
    };
  } catch {
    return null;
  }
}

/**
 * Whether `record` describes an older graph than the one there is now: the
 * workspace has been ingested since it ran. `ix status` then shows it as
 * history, not as advice. Unknown (no current ingest time) is not outdated.
 */
export function verifyRecordOutdated(record: Pick<VerifyRecord, "lastIngestAt">, lastIngestAt: string | null | undefined): boolean {
  return typeof lastIngestAt === "string" && record.lastIngestAt !== lastIngestAt;
}

/** Best-effort, like the other per-root state files: a failed write costs a status line. */
export function saveVerifyRecord(record: VerifyRecord): boolean {
  try {
    const target = verifyRecordPath(record.root);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Run ──────────────────────────────────────────────────────────────────

export interface RunVerifyOptions {
  sample?: number;
  seed?: number;
  /** Workspace-relative paths to verify first. */
  paths?: readonly string[];
  /** For tests: stands in for `loadIngestionModules`. */
  loadModules?: () => Promise<Awaited<ReturnType<typeof loadIngestionModules>>>;
  now?: () => Date;
  /**
   * Save the record `ix status` reads (default true). Only a whole-root run
   * does: a run given `paths` never saves, and `ix doctor` passes false.
   */
  record?: boolean;
  /**
   * Stop starting new work after this many ms (`ix doctor`). Files not judged
   * by then are left out and the report is `partial`. Never saves a record.
   */
  budgetMs?: number;
}

type VerifyClient = Pick<IxClient, "listByKind" | "getSourceHashes"> & Partial<Pick<IxClient, "stats">>;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const fileResult = (path: string, state: VerifyFileState, reason?: string): VerifyFileResult => ({
  path, state, ...(reason ? { reason } : {}), expectedNodes: 0, storedNodes: 0, missing: [], extra: [], changed: [],
});

/**
 * Verify `root`'s graph against a re-parse of a sample of its files.
 *
 * Never throws for a verdict: no workspace, no baseline, a changed extractor or
 * a parser that will not load are all `graph: "unverified"` with a reason. A
 * backend nobody answers at is rethrown, so the caller can report it the way
 * every read command does; any other failed read only makes its file
 * unverified.
 */
export async function runVerify(client: VerifyClient, rootInput: string, opts: RunVerifyOptions = {}): Promise<VerifyReport> {
  // Ingest saves its baseline under the canonical root (`resolveIngestRoot`),
  // and `loadIngestBaseline` compares the string exactly.
  const root = canonicalWorkspacePath(rootInput);
  const sample = opts.sample ?? DEFAULT_VERIFY_SAMPLE;
  const seed = opts.seed ?? DEFAULT_VERIFY_SEED;
  const at = (opts.now?.() ?? new Date()).toISOString();
  const startedMs = Date.now();
  const overBudget = (): boolean => opts.budgetMs !== undefined && Date.now() - startedMs >= opts.budgetMs;
  let partial = false;
  const unverified = (reason: string, fix: string | null, lastIngestAt: string | null = null): VerifyReport => ({
    at, root, lastIngestAt, graph: "unverified", reason, fix, sample, seed,
    counts: { files: 0, clean: 0, stale: 0, diverged: 0, unverified: 0 }, files: [],
  });

  // Read-only lookup: `workspaceStateFor` registers and migrates as it goes.
  const workspace = findWorkspaceForCwd(root);
  const baseline = workspace ? loadIngestBaseline(root) : null;
  if (!workspace || !baseline) return unverified("not_mapped", GRAPH_MAP_FIX);

  let modules: Awaited<ReturnType<typeof loadIngestionModules>>;
  try {
    modules = await (opts.loadModules ?? loadIngestionModules)();
  } catch {
    return unverified("parser_unavailable", null, baseline.lastIngestAt);
  }
  const [{ parseFile, isGrammarSupported }, { buildPatchWithResolution, extractorName }] = modules;
  // A re-parse by another extractor would disagree with every file for a
  // reason that is not the graph's fault, and `ix map` re-extracts anyway.
  if (extractorChanged(baseline, extractorName())) {
    return unverified("extractor_changed", GRAPH_MAP_FIX, baseline.lastIngestAt);
  }

  const { fileWorkspaceId, fileMultiRepo } = fileIdentity(root, workspace.workspace_id);
  const supported = (rel: string): boolean => {
    try { return isGrammarSupported(rel); } catch { return false; }
  };
  const rels = pickVerifyFiles(root, baseline, { sample, seed, explicit: opts.paths, supported });
  const known = new Set<string>();
  for (const key of baseline.files.keys()) {
    const rel = baselineRelPath(root, key);
    if (rel !== null) known.add(rel);
  }

  const timedOut = new Set(baseline.parseTimeouts.map(normalizePathSeparators));

  // Files the last ingest replayed (F-01 suspects) that have not changed since.
  const replayedSet = new Set(baseline.replayedFiles.map(normalizePathSeparators));
  const ingestMs = Date.parse(baseline.lastIngestAt);
  const replayedUnchanged = (rel: string): boolean => {
    if (!replayedSet.has(rel) || Number.isNaN(ingestMs)) return false;
    try { return fs.statSync(nodePath.join(root, rel)).mtimeMs <= ingestMs; } catch { return false; }
  };

  interface Parsed { rel: string; ws: string; hash: string; replayed: boolean; expected: Map<string, VerifyNode> }
  const done = new Map<string, VerifyFileResult>();
  const parsed: Parsed[] = [];
  for (const rel of rels) {
    if (overBudget()) { partial = true; break; }
    // Only a named path gets here: ingest gave up on its parse, so it is not in
    // the graph, and parsing it on this thread would have no budget at all.
    if (timedOut.has(rel)) { done.set(rel, fileResult(rel, "unverified", "parse_timed_out")); continue; }
    // One handle for the size check and the read (no stat-then-read race).
    // Ingest's own size gate: such a file is not in the graph, and the cap
    // bounds the in-process parse of a named one.
    let read: ReturnType<typeof readBoundedBytes> | null;
    try {
      read = readBoundedBytes(nodePath.join(root, rel), VERIFY_MAX_FILE_BYTES);
    } catch {
      // Windows will not open a directory at all; it is still not a file,
      // which is not the same as missing.
      let exists = false;
      try { exists = fs.statSync(nodePath.join(root, rel)) !== undefined; } catch { /* missing */ }
      read = exists ? { refused: "not_file" } : null;
    }
    if (read && "refused" in read && read.refused === "too_large") {
      done.set(rel, fileResult(rel, "unverified", "too_large"));
      continue;
    }
    if (read && "refused" in read && read.refused === "not_file") {
      // A directory or other non-regular file where the graph may have had a
      // file: present, so not missing_on_disk.
      done.set(rel, known.has(rel) ? fileResult(rel, "stale", "not_file") : fileResult(rel, "unverified", "not_file"));
      continue;
    }
    if (!read || !("bytes" in read)) {
      // In the baseline, gone from disk: the graph has not caught up with a
      // deletion, which is what `ix map` is for.
      done.set(rel, known.has(rel) ? fileResult(rel, "stale", "missing_on_disk") : fileResult(rel, "unverified", "missing_on_disk"));
      continue;
    }
    const bytes = read.bytes;
    if (!supported(rel)) { done.set(rel, fileResult(rel, "unverified", "unsupported_language")); continue; }
    const hash = sha256(bytes);
    try {
      const result = parseFile(rel, bytes.toString("utf-8"));
      if (!result) { done.set(rel, fileResult(rel, "unverified", "no_parse")); continue; }
      // The 6th argument is ingest's multi-repo context; the loader's type predates it.
      const build = buildPatchWithResolution as (...args: unknown[]) => { ops: Array<Record<string, unknown>> };
      const patch = build(result, hash, fileWorkspaceId(rel), [], undefined, fileMultiRepo(rel));
      parsed.push({ rel, ws: fileWorkspaceId(rel), hash, replayed: replayedUnchanged(rel), expected: expectedNodes(patch) });
    } catch {
      done.set(rel, fileResult(rel, "unverified", "no_parse"));
    }
  }

  // Out of budget already: no network reads for files that could not finish.
  if (overBudget() && parsed.length > 0) { partial = true; parsed.length = 0; }

  // One call for every file. null = the lookup failed, so stale and diverged
  // cannot be told apart; a file that matches is still clean.
  let storedHashes: Map<string, string> | null = new Map();
  if (parsed.length > 0) {
    try {
      const rows = await client.getSourceHashes(
        [...new Set(parsed.map((p) => p.rel))],
        [...new Set(parsed.map((p) => p.ws))],
      );
      for (const r of rows) storedHashes.set(`${r.workspaceId ?? ""}\u0000${r.uri}`, r.hash);
    } catch (err) {
      if (isBackendUnreachable(err)) throw err;
      storedHashes = null;
    }
  }

  // Every kind each workspace holds, so a stored node of a kind the parse no
  // longer produces (and the default list lacks) is still read and seen as
  // extra. `/v1/list` needs a kind, and the backend accepts any kind string.
  const wsKinds = new Map<string, string[]>();
  for (const ws of new Set(parsed.map((p) => p.ws))) {
    try {
      const stats = await client.stats?.({ workspaceId: ws, timeoutMs: VERIFY_STATS_TIMEOUT_MS });
      const byKind = stats?.nodes?.byKind;
      if (Array.isArray(byKind)) {
        wsKinds.set(ws, byKind.map((k: { kind?: unknown }) => k?.kind).filter((k): k is string => typeof k === "string"));
      }
    } catch (err) {
      if (isBackendUnreachable(err)) throw err;
    }
  }

  const reads = parsed.flatMap((p) => {
    const kinds = new Set([...VERIFY_DEFAULT_KINDS, ...(wsKinds.get(p.ws) ?? [])]);
    for (const node of p.expected.values()) kinds.add(node.kind);
    kinds.delete("chunk");
    return [...kinds].sort().map((kind) => ({ p, kind }));
  });
  const results = await mapLimit(reads, VERIFY_CONCURRENCY, async ({ p, kind }) => {
    if (overBudget()) {
      partial = true;
      return { rel: p.rel, rows: [] as GraphNode[], failed: false, skipped: true };
    }
    try {
      const rows = await client.listByKind(kind, { scope: p.rel, workspaceId: p.ws, limit: VERIFY_LIST_LIMIT });
      return { rel: p.rel, rows: Array.isArray(rows) ? rows : [], failed: false, skipped: false };
    } catch (err) {
      if (isBackendUnreachable(err)) throw err;
      return { rel: p.rel, rows: [] as GraphNode[], failed: true, skipped: false };
    }
  });
  // A file with any kind left unread is not judged at all: half its nodes
  // would read as missing.
  const skipped = new Set(results.filter((r) => r.skipped).map((r) => r.rel));
  const byFile = new Map<string, { rows: GraphNode[]; failed: boolean; truncated: boolean }>();
  for (const r of results) {
    const entry = byFile.get(r.rel) ?? { rows: [], failed: false, truncated: false };
    entry.rows.push(...r.rows);
    entry.failed ||= r.failed;
    entry.truncated ||= r.rows.length >= VERIFY_LIST_LIMIT;
    byFile.set(r.rel, entry);
  }

  for (const p of parsed) {
    if (skipped.has(p.rel)) continue;
    const read = byFile.get(p.rel) ?? { rows: [], failed: true, truncated: false };
    if (read.failed) { done.set(p.rel, fileResult(p.rel, "unverified", "list_failed")); continue; }
    const stored = storedNodes(read.rows as unknown as Array<Record<string, unknown>>, p.rel);
    const diff = diffNodes(p.expected, stored);
    const storedHash = storedHashes === null ? null : storedHashes.get(`${p.ws}\u0000${p.rel}`);
    const { state, reason } = classifyFile(p.hash, storedHash, diff, read.truncated, stored.size, p.replayed);
    done.set(p.rel, {
      path: p.rel, state, ...(reason ? { reason } : {}),
      expectedNodes: p.expected.size, storedNodes: stored.size,
      ...diff,
    });
  }

  const files = rels.map((rel) => done.get(rel)!).filter(Boolean);
  const counts = countStates(files);
  const verdict = graphVerdict(counts);
  // Nothing judged before the budget ran out says so, not "no files".
  if (partial && verdict.graph === "unverified") Object.assign(verdict, { reason: "timed_out" });
  const report: VerifyReport = {
    at, root, lastIngestAt: baseline.lastIngestAt,
    graph: verdict.graph, ...(verdict.reason ? { reason: verdict.reason } : {}), fix: verdict.fix,
    sample, seed, counts, files, ...(partial ? { partial: true } : {}),
  };
  // A partial run (named files, or a caller that opts out) must not replace
  // the sampled record `ix status` shows.
  if (opts.record !== false && !partial && !(opts.paths && opts.paths.length > 0)) saveVerifyRecord(recordFromReport(report));
  return report;
}
