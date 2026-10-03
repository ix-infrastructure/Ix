// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { isTestPath } from "./related-files.js";
import { resolveToken, type RepoAccess } from "./text-references.js";

/**
 * From an issue's text to the files its fix starts in, for
 * `ix context --from-issue`.
 *
 * Measured on SWE-PolyBench (28 fresh instances, not used while building
 * this): resolving the code names an issue mentions to their definitions put
 * a changed file in the top five 0.600 of the time, against 0.485 for BM25
 * over the repository. But a graph-expanded bundle, ranked by graph distance,
 * lost to BM25 at equal size (0.57 against 0.67). So the ranking here is
 * lexical first: the resolved starting files lead, BM25 against the issue
 * orders the rest, and graph closeness to a starting point only breaks ties
 * and nudges.
 *
 * Starting points, most specific first:
 *
 *  1. file paths the issue names, resolved against the tracked files;
 *  2. multi-part identifiers -- `newJsonWriter`, `save_model`, `GsonBuilder`
 *     -- from backticks or running text. A multi-part name is almost always a
 *     code name;
 *  3. single backticked words of four letters or more. `save` was the right
 *     start for a keras fix; `flex`, `code` and `version` were not, which is
 *     why a single word counts only in backticks, and only after the rest.
 *
 * A name resolves only to an exact-name definition in source code. The first
 * pilot run started from a CSS output file, a changelog, test fixtures, and an
 * import: `borderStylesReset` resolved to the file that imported it, because
 * the graph's `module` entity for an import is located in the importing file.
 */

/** Starting points a bundle is built from. */
export const MAX_STARTS = 3;
/** Candidate names looked up, in order. */
export const MAX_CANDIDATES = 25;
/** Files larger than this are not scored: generated, bundled or data. */
export const MAX_BM25_BYTES = 200 * 1024;
/** Ranked files carried in the JSON bundle. */
export const MAX_RANKED_FILES = 20;
/**
 * How much being next to a starting point is worth, as a fraction of a file's
 * BM25 score. Small on purpose: on the benchmark, graph order lost to BM25 at
 * equal size, so closeness may reorder files the text scores alike and may
 * not overturn a clear lexical lead.
 */
export const CLOSENESS_BOOST = 0.1;

/** Extensions of files a fix edits. */
const CODE_EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "java", "svelte", "vue", "go", "rs",
  "kt", "kts", "scala", "rb", "php", "cs", "c", "h", "cc", "cpp", "hpp", "swift",
];
const CODE_FILE = new RegExp(`\\.(?:${CODE_EXTENSIONS.join("|")})$`);

/**
 * Not code a fix edits: tests, test data, samples, docs, vendored or built
 * output. The pilot's list, plus what `isTestPath` already knows.
 *
 * The second line is a project's website, playground, test configuration,
 * benchmarks, stories and end-to-end suites. Svelte's `site/` alone was 40
 * of the wrong files in Ix's top-10 rankings over two samples of issues; none
 * of these directories holds any of the 932 files the 382 SWE-PolyBench
 * Verified fixes change.
 */
const NOISE = new RegExp(
  "(^|/)(__tests__|tests?|spec|specs|fixtures?|__fixtures__|test-fixtures|samples|examples?|vendor|"
  + "third_party|node_modules|dist|build|coverage|docs?|changelog_unreleased|"
  + "site|website|docs-site|playground|tests?[_-]config|benchmarks|\\.?storybook|e2e|cypress|integration-tests)/"
  + "|\\.(test|spec)\\.[^/]+$|\\.min\\.js$|(^|/)test_[^/]+\\.py$|_test\\.(py|go)$",
);

/** Source code a fix would edit: a code file that is not a test, fixture, doc or build output. */
export function isSourcePath(path: string): boolean {
  return CODE_FILE.test(path) && !NOISE.test(path) && !isTestPath(path);
}

// A path-like token with a code extension: `saving_api.py`, `src/a/index.ts`,
// and the absolute path of a stack trace frame or the tail of a repository URL,
// `/home/u/proj/src/a.py` and `//github.com/o/r/blob/main/src/a.py`, which
// `resolveIssuePath` cuts down to the tracked path they end in.
//
// The lookbehind refuses `.` and `-` as well as `\w` and `/`: a match can then
// only begin where a run of path characters begins, so a long unbroken run --
// a pasted UUID list, a row of dots -- is scanned once, not once per `.`.
const PATH = new RegExp(
  `(?<![\\w/.-])(\\/*(?:[\\w.-]+/)*[\\w.-]+\\.(?:${CODE_EXTENSIONS.join("|")}))\\b`, "g");
const BACKTICK = /`([^`\n]{2,80})`/g;
const WORD = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
// camelCase, PascalCase with two or more parts, snake_case, SCREAMING_SNAKE.
const IDENT_SOURCE =
  "(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)";
const IDENT = new RegExp(`\\b${IDENT_SOURCE}\\b`, "g");
const IDENT_FULL = new RegExp(`^${IDENT_SOURCE}$`);

export interface IssueCandidates {
  /** Path-like tokens, in the order the issue names them. */
  paths: string[];
  /** Code names: multi-part first, then single backticked words. */
  identifiers: string[];
}

/** The paths and code names an issue mentions, most specific first. */
export function extractCandidates(text: string): IssueCandidates {
  const paths = unique([...text.matchAll(PATH)].map((m) => m[1]));
  // A path's own parts are not names in the issue: `saving_api` in
  // `saving/saving_api.py` is the path again, not a function.
  const prose = text.replace(PATH, " ");
  const inTicks = [...prose.matchAll(BACKTICK)].flatMap((m) => [...m[1].matchAll(WORD)].map((w) => w[0]));
  const multi = [...inTicks, ...[...prose.matchAll(IDENT)].map((m) => m[0])].filter((t) => IDENT_FULL.test(t));
  const single = inTicks.filter((t) => !IDENT_FULL.test(t) && t.length >= 4);
  // Only MAX_STARTS names become starts, so order decides: a short common
  // word (`repeat`, `ignore`) mentioned first took a slot a specific one
  // (`Stylesheet`) mentioned later needed. Common words still resolve, last.
  const ordered = [
    ...multi,
    ...single.filter((t) => !isGenericIdentifier(t)),
    ...single.filter((t) => isGenericIdentifier(t)),
  ];
  const seen = new Set(paths);
  const identifiers: string[] = [];
  for (const token of ordered) {
    if (seen.has(token)) continue;
    seen.add(token);
    identifiers.push(token);
  }
  return { paths, identifiers: identifiers.slice(0, MAX_CANDIDATES) };
}

/** One search hit, as the starting-point picker needs it. */
export interface SymbolHit {
  id: string;
  name: string;
  kind: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
}

export type StartVia = "path in issue" | "identifier in issue" | "bm25 fallback";

export interface StartingPoint {
  /** What the issue said: the path or name as written. */
  token: string;
  /** The graph node, when known. A path start may have none. */
  id?: string;
  name: string;
  kind: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  via: StartVia;
}

/** Kinds a definition has, most navigable first. Anything else ranks after. */
const DEFINITION_KINDS = [
  "class", "interface", "trait", "struct", "enum", "type", "object", "function", "method",
  "constant", "variable", "property", "field",
];
/** Never a definition: an import (located in the importer), a chunk, a file. */
const NOT_DEFINITIONS = new Set(["module", "chunk", "file"]);

function kindRank(kind: string): number {
  const i = DEFINITION_KINDS.indexOf(kind.toLowerCase());
  return i === -1 ? DEFINITION_KINDS.length : i;
}

export interface PickDeps {
  /** Tracked files, repository-relative. Empty outside a git checkout. */
  files: string[];
  /** The symbol index: the search `ix search` runs. */
  search: (name: string) => Promise<SymbolHit[]>;
  /**
   * How well a file matches the issue's text. Breaks a tie between two
   * definitions of one name -- `renderRow` in `table.ts` and in `grid.ts` --
   * in favour of the one the issue reads like.
   */
  fileScore?: (path: string) => number;
}

/**
 * Up to `max` starting points, first found wins, one per file; and the
 * candidates that resolved to nothing. Candidates after the last start are
 * not looked up, and not reported as unresolved.
 */
export async function pickStartingPoints(
  text: string,
  deps: PickDeps,
  max = MAX_STARTS,
): Promise<{ starts: StartingPoint[]; unresolved: string[] }> {
  const { paths, identifiers } = extractCandidates(text);
  const starts: StartingPoint[] = [];
  const unresolved: string[] = [];
  const taken = (path: string) => starts.some((s) => s.path === path);

  const tracked = new Set(deps.files);
  const byBasename = new Map<string, string[]>();
  for (const file of deps.files) {
    // push, not a spread: copying the list on every insert was quadratic in
    // the number of files sharing a basename (index.ts, README.md).
    const base = posix.basename(file);
    const list = byBasename.get(base);
    if (list) list.push(file);
    else byBasename.set(base, [file]);
  }
  for (const token of paths) {
    if (starts.length >= max) return { starts, unresolved };
    const path = resolveIssuePath(token, tracked, byBasename);
    if (!path || !isSourcePath(path)) {
      unresolved.push(token);
      continue;
    }
    if (!taken(path)) starts.push({ token, name: posix.basename(path), kind: "file", path, via: "path in issue" });
  }

  const score = deps.fileScore ?? (() => 0);
  for (const token of identifiers) {
    if (starts.length >= max) break;
    // Not caught: a backend that cannot answer is an error to report, not an
    // issue that names nothing.
    const hits = (await deps.search(token))
      .filter((h): h is SymbolHit & { path: string } =>
        h.name === token && !!h.path && !NOT_DEFINITIONS.has(h.kind.toLowerCase()) && isSourcePath(h.path))
      .sort((a, b) =>
        kindRank(a.kind) - kindRank(b.kind) || score(b.path) - score(a.path) || cmp(a.path, b.path));
    if (hits.length === 0) {
      unresolved.push(token);
      continue;
    }
    const best = hits[0];
    if (taken(best.path)) continue;
    starts.push({
      token, id: best.id, name: best.name, kind: best.kind, path: best.path,
      ...(best.lineStart !== undefined ? { lineStart: best.lineStart } : {}),
      ...(best.lineEnd !== undefined ? { lineEnd: best.lineEnd } : {}),
      via: "identifier in issue",
    });
  }
  return { starts, unresolved };
}

/**
 * A path as an issue writes it, to the tracked file it names. First as
 * `resolveToken` reads a path in code; then, for an absolute path from a
 * stack trace or the tail of a repository URL, the longest of its suffixes
 * that is a tracked path: `/home/u/proj/src/a.py` and
 * `//github.com/o/r/blob/main/src/a.py` both name `src/a.py`.
 */
function resolveIssuePath(
  token: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
): string | undefined {
  const direct = resolveToken(token, "", tracked, byBasename);
  if (direct) return direct;
  const parts = token.split("/");
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join("/");
    if (tracked.has(suffix)) return suffix;
  }
  return undefined;
}

const BM25_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
const BM25_PART = /[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g;
const PLAIN_WORD = /^[a-z0-9]+$/;

/**
 * Calls `emit` with each BM25 word of `text`, in order: an identifier's parts,
 * split at camelCase and underscores and lowercased, then -- for a name of two
 * parts or more -- the whole name, lowercased and without underscores. Parts
 * and names of two letters or fewer are dropped.
 *
 * The parts let "list by kind" in an issue match `listByKind`; the whole name
 * lets `borderStylesReset` in an issue match the file that defines it far
 * above the hundred files that say "border" and "reset". The whole name is
 * spelled the same for `save_model` and `saveModel`.
 */
function eachBm25Token(text: string, emit: (token: string) => void): void {
  for (const m of text.matchAll(BM25_WORD)) {
    const word = m[0];
    if (PLAIN_WORD.test(word)) {
      // Most words: one lowercase part, nothing to split.
      if (word.length > 2) emit(word);
      continue;
    }
    const parts = word.match(BM25_PART) ?? [];
    for (const part of parts) if (part.length > 2) emit(part.toLowerCase());
    if (parts.length > 1) {
      const whole = word.replace(/_/g, "").toLowerCase();
      if (whole.length > 2) emit(whole);
    }
  }
}

/** The BM25 words of `text`, as {@link eachBm25Token} yields them. */
export function bm25Tokens(text: string): string[] {
  const out: string[] = [];
  eachBm25Token(text, (t) => out.push(t));
  return out;
}

/**
 * Words an issue is written in that say nothing about where the code is:
 * English function words and the vocabulary of bug reports. Dropped from the
 * query only. Code comments are English too, so without this "should",
 * "would" and "expected" pull the most-commented files up.
 */
const BM25_STOPWORDS = new Set((
  "the and for are but not you all any can had her was one our out has him his how its may new now old see "
  + "two way who did get let say she too use about above after again also been before being below between both "
  + "could does doing down during each few from further have having here into just more most much must only other "
  + "over own same should some such than that their them then there these they this those through under until very "
  + "want what when where which while whom why will with would your yours "
  + "bug bugs issue issues expected behavior behaviour actual reproduce reproduction steps version versions "
  + "current currently describe description problem thanks thank please like think seems seem happen happens "
  + "work works working instead because since using used example following sure able still even though"
).split(" "));

/**
 * How much more a query word counts when it is part of a code name the issue
 * mentions (`extractCandidates`) than when it is only in the prose.
 */
export const BM25_IDENTIFIER_WEIGHT = 2;

/** Each query word, with its weight: 1 for prose, more for a word of a named identifier. */
export function bm25QueryWeights(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const t of bm25Tokens(query)) if (!BM25_STOPWORDS.has(t)) weights.set(t, 1);
  for (const id of extractCandidates(query).identifiers) {
    for (const t of bm25Tokens(id)) if (weights.has(t)) weights.set(t, BM25_IDENTIFIER_WEIGHT);
  }
  return weights;
}

export interface Bm25Hit {
  path: string;
  score: number;
}

/** One file as BM25 reads it: how often each counted word occurs, and its length in words. */
export interface Bm25Doc {
  tf: Map<string, number>;
  length: number;
}

/**
 * A file's text as BM25 reads it, or undefined when it is not scored (too
 * large, or unreadable). `wanted` limits the words counted -- see `bm25Rank`;
 * without it every word is, which is what the on-disk index stores.
 */
export function bm25Doc(path: string, text: string | undefined, wanted?: ReadonlySet<string>): Bm25Doc | undefined {
  if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_BM25_BYTES) return undefined;
  const tf = new Map<string, number>();
  let length = 0;
  // Counted as the words stream past: no array per file.
  const count = (t: string) => {
    length++;
    if (!wanted || wanted.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
  };
  eachBm25Token(path.replace(/\//g, " "), count);
  eachBm25Token(text, count);
  return { tf, length };
}

/** The query's scored words (stopwords dropped), in the order it first uses them. */
export function bm25QueryTerms(query: string): string[] {
  return [...bm25QueryWeights(query).keys()];
}

/**
 * Okapi BM25 (k1 1.2, b 0.75) of each file against `query`, best first, files
 * that share no word with it left out. A file's path is part of its text, so
 * `auth/login.ts` matches an issue about logging in before it is opened.
 *
 * The query is the issue's words less {@link BM25_STOPWORDS}, and a word of a
 * code name the issue mentions counts {@link BM25_IDENTIFIER_WEIGHT} times.
 * Measured in `scripts/ranking-eval` on 104 SWE-PolyBench dev issues, the
 * three together took BM25's recall at 5/10/20 from 0.50/0.64/0.72 to
 * 0.59/0.74/0.84, and leaving any one out lowered it; a separate path field,
 * other k1 and b, and a lower size cap did not help.
 */
export function bm25Rank(
  repo: Pick<RepoAccess, "read">,
  files: string[],
  query: string,
  k1 = 1.2,
  b = 0.75,
): Bm25Hit[] {
  // Only the query's words are counted: BM25 needs no other term frequency,
  // and a map of every word of every file is most of the memory and a third
  // of the time on a large repository. A document's length is still every word.
  const weights = bm25QueryWeights(query);
  const wanted = new Set(weights.keys());
  const docs = new Map<string, Bm25Doc>();
  for (const path of files) {
    const doc = bm25Doc(path, repo.read(path), wanted);
    if (doc) docs.set(path, doc);
  }
  return bm25Score(docs, weights, k1, b);
}

/**
 * BM25 of already-tokenized files. Split out of `bm25Rank` so the on-disk
 * index (`bm25-cache.ts`) scores through the very same arithmetic: the same
 * documents in, the same scores out, to the last bit.
 */
export function bm25Score(
  docs: ReadonlyMap<string, Bm25Doc>,
  weights: ReadonlyMap<string, number>,
  k1 = 1.2,
  b = 0.75,
): Bm25Hit[] {
  if (docs.size === 0) return [];
  const n = docs.size;
  let total = 0;
  const df = new Map<string, number>();
  for (const doc of docs.values()) {
    total += doc.length;
    for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avg = total / n || 1;
  const out: Bm25Hit[] = [];
  for (const [path, doc] of docs) {
    let score = 0;
    for (const [t, weight] of weights) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const d = df.get(t)!;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
    }
    if (score > 0) out.push({ path, score });
  }
  return out.sort((a, c) => c.score - a.score || cmp(a.path, c.path));
}

export interface IssuePlan {
  starts: StartingPoint[];
  unresolved: string[];
  /** True when nothing in the issue resolved and the start is BM25's best file. */
  fallback: boolean;
  /** BM25 over the tracked source files, best first. */
  bm25: Bm25Hit[];
}

/**
 * Starting points and the lexical ranking for one issue. Without a git
 * checkout there is no file list: paths do not resolve, BM25 is empty, and
 * only names can start the bundle.
 */
export async function planIssue(
  text: string,
  deps: {
    repo?: RepoAccess;
    search: PickDeps["search"];
    /** BM25 over the source files; `bm25Rank` unless the caller has an index. */
    rank?: (repo: RepoAccess, files: string[], query: string) => Bm25Hit[];
  },
): Promise<IssuePlan> {
  const files = deps.repo?.files() ?? [];
  const rank = deps.rank ?? bm25Rank;
  const bm25 = deps.repo ? rank(deps.repo, files.filter(isSourcePath), text) : [];
  const scores = new Map(bm25.map((h) => [h.path, h.score]));
  const { starts, unresolved } = await pickStartingPoints(text, {
    files, search: deps.search, fileScore: (p) => scores.get(p) ?? 0,
  });
  if (starts.length > 0 || bm25.length === 0) return { starts, unresolved, fallback: false, bm25 };
  const top = bm25[0].path;
  return {
    starts: [{ token: top, name: posix.basename(top), kind: "file", path: top, via: "bm25 fallback" }],
    unresolved,
    fallback: true,
    bm25,
  };
}


/**
 * Whether an identifier the issue names is too common to point anywhere: a
 * short all-lowercase word such as `debug`, `bind`, `config` or `render`
 * resolves to *a* definition, rarely the one the fix touches. Specific names
 * carry an inner capital (`toJsonTree`, `JsonWriter`), an underscore
 * (`get_openai_callback`), or length.
 *
 * Fixed before it was scored on held-out samples: on SWE-PolyBench issues the
 * starts it keeps were in the gold patch 20 times in 32, the ones it drops 2
 * in 7.
 */
export function isGenericIdentifier(token: string): boolean {
  return !(/[a-z][A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token) || token.includes("_") || token.length >= 8);
}

/** How far a plan's starting points can be trusted, and which ones. */
export interface IssueConfidence {
  confident: boolean;
  /** The starts worth pointing an agent at: named paths and specific identifiers. */
  starts: StartingPoint[];
  /** Why not, when not confident. */
  reason?: string;
}

/**
 * A plan is confident when the issue named a path, or a specific identifier,
 * that resolved. A BM25 fallback never is: across four samples of
 * SWE-PolyBench issues its start was in the gold patch once in 55.
 */
export function issueConfidence(plan: Pick<IssuePlan, "starts" | "fallback">): IssueConfidence {
  if (plan.fallback) {
    return { confident: false, starts: [], reason: "no code name in the issue resolved to a definition" };
  }
  const starts = plan.starts.filter((s) => s.via === "path in issue"
    || (s.via === "identifier in issue" && !isGenericIdentifier(s.token)));
  if (starts.length === 0) {
    const names = plan.starts.map((s) => s.token);
    return {
      confident: false,
      starts,
      reason: names.length > 0
        ? `only common words resolved (${names.join(", ")}), which name many definitions`
        : "nothing in the issue resolved to a definition",
    };
  }
  return { confident: true, starts };
}

/** Files after the starting points in a lean view. */
export const LEAN_RANKED = 4;

/** `ix context --from-issue --lean`: where to start, and nothing else. */
export interface LeanIssueView {
  confidence: "high" | "low";
  reason?: string;
  startingPoints: StartingPoint[];
  /** The next files by BM25 against the issue, starting files excluded. */
  alsoRanked: RankedFile[];
  unresolved: string[];
}

/**
 * The lean view of a plan. A full bundle costs about 1.5k tokens, and an
 * agent re-reads it on every turn; on SWE-PolyBench it added a median 14%
 * tokens even where its start was right, and saved no turns. What the agent
 * uses is the pointer, so that is all this keeps: the trusted starting points
 * and a few ranked files -- Ix's starts, then BM25, the ordering that beat
 * both alone on held-out issues. When nothing is trusted it says so, rather
 * than pointing the agent at a guess.
 */
export function leanIssueView(plan: IssuePlan, ranked = LEAN_RANKED): LeanIssueView {
  const c = issueConfidence(plan);
  if (!c.confident) {
    return { confidence: "low", reason: c.reason, startingPoints: [], alsoRanked: [], unresolved: plan.unresolved };
  }
  const startPaths = new Set(c.starts.map((s) => s.path));
  const alsoRanked = rankIssueFiles({ starts: [], bm25: plan.bm25, near: new Map() }, ranked + startPaths.size)
    .filter((f) => !startPaths.has(f.path))
    .slice(0, ranked);
  return { confidence: "high", startingPoints: c.starts, alsoRanked, unresolved: plan.unresolved };
}

/** BM25 files tried, best first, for one the graph has a node for. */
export const CENTRE_FALLBACK_TRIES = 10;

/**
 * The starting point a bundle is centred on: the first start the graph has a
 * node for, else the best BM25 file that has one.
 *
 * A start can have no node: the graph does not index every tracked file.
 * On SWE-PolyBench two svelte issues named no code, BM25's top file was a
 * `.svelte` component, and the command failed with no bundle at all while
 * the fifth-ranked file was a perfectly good `.js` module. Walking BM25's
 * ranking finds that one; the files the walk skipped still rank as usual.
 * `walked` says the centre came from this walk, which is a fallback too.
 */
export async function chooseCentre(
  starts: StartingPoint[],
  bm25: Bm25Hit[],
  findNode: (path: string) => Promise<string | undefined>,
  tries = CENTRE_FALLBACK_TRIES,
): Promise<{ starts: StartingPoint[]; centre?: StartingPoint; walked: boolean }> {
  const located = await Promise.all(starts.map(async (s) => {
    const id = s.id ?? (await findNode(s.path));
    return id ? { ...s, id } : s;
  }));
  const found = located.find((s) => s.id);
  if (found) return { starts: located, centre: found, walked: false };
  const tried = new Set(located.map((s) => s.path));
  for (const hit of bm25.filter((h) => !tried.has(h.path)).slice(0, tries)) {
    const id = await findNode(hit.path);
    if (!id) continue;
    const centre: StartingPoint = {
      token: hit.path, id, name: posix.basename(hit.path), kind: "file", path: hit.path, via: "bm25 fallback",
    };
    return { starts: [...located, centre], centre, walked: true };
  }
  return { starts: located, walked: false };
}

export interface RankedFile {
  path: string;
  /** BM25 against the issue, boosted by closeness to a starting point. */
  score: number;
  reason: string;
}

/** Why a file is near a starting point, and how near: 1 one hop, 0.5 two. */
export interface Closeness {
  weight: number;
  reason: string;
}

/**
 * The files to read, best first: the starting files in the order they were
 * found, then every other source file by
 *
 *     bm25(file, issue) * (1 + CLOSENESS_BOOST * closeness(file))
 *
 * where closeness is 1 for a file one hop from a starting point, 0.5 for one
 * of its ranked related files, 0 otherwise. Ties go to the closer file, then
 * the path. A graph neighbour the issue's text does not match at all still
 * ranks, after every file it does match.
 */
export function rankIssueFiles(
  input: { starts: StartingPoint[]; bm25: Bm25Hit[]; near: ReadonlyMap<string, Closeness> },
  limit = MAX_RANKED_FILES,
): RankedFile[] {
  const lexical = new Map(input.bm25.map((h) => [h.path, h.score]));
  const out: RankedFile[] = [];
  const startPaths = new Set<string>();
  for (const s of input.starts) {
    if (startPaths.has(s.path)) continue;
    startPaths.add(s.path);
    out.push({
      path: s.path,
      score: round(lexical.get(s.path) ?? 0),
      reason: `starting point (${s.via}: ${s.token})`,
    });
  }
  const pool = new Set([...lexical.keys(), ...input.near.keys()]);
  const rest = [...pool]
    .filter((path) => !startPaths.has(path) && isSourcePath(path))
    .map((path) => {
      const bm25 = lexical.get(path) ?? 0;
      const near = input.near.get(path);
      const closeness = near?.weight ?? 0;
      const reason = [bm25 > 0 ? `bm25 ${bm25.toFixed(2)}` : "no bm25 match", near?.reason]
        .filter(Boolean).join("; ");
      return { path, score: bm25 * (1 + CLOSENESS_BOOST * closeness), closeness, reason };
    })
    .sort((a, b) => b.score - a.score || b.closeness - a.closeness || cmp(a.path, b.path));
  for (const r of rest) out.push({ path: r.path, score: round(r.score), reason: r.reason });
  return out.slice(0, limit);
}

/**
 * The issue's text: a file, or stdin for `-`. `stdin` is a parameter so the
 * stream can be replaced under test.
 */
export async function readIssueText(
  arg: string,
  stdin: AsyncIterable<unknown> = process.stdin,
): Promise<string> {
  if (arg !== "-") return decodeIssue(readFileSync(arg));
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array));
  }
  return decodeIssue(Buffer.concat(chunks));
}

/**
 * UTF-8, unless a byte-order mark says UTF-16. Windows PowerShell 5.1's `>`
 * writes UTF-16LE with a BOM, so `gh issue view 1 --json body -q .body >
 * issue.md` there produces a file that, read as UTF-8, is every letter
 * followed by a NUL: no name, no path, and no BM25 word in it.
 */
function decodeIssue(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
    return swapped.swap16().toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
