// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { SourceFiles } from "../edge-sites.js";
import { isSourcePath } from "../explain/issue.js";
import type { FileDiff } from "./session.js";
import { canonicalPath, gitShowHead, symbolKey } from "./session.js";
import { hookTimeoutMs, postToolUseOutput } from "./io.js";
import {
  DEFAULT_TOKEN_BUDGET, estimateTokens, fitToBudget, gatherAround, hasDependents, type AroundRequest, type AroundResult, type LineRange,
} from "../around.js";
import { renderAroundText } from "../around-render.js";

/**
 * `ix hook claude-post-edit`: Claude Code's PostToolUse hook, the part that
 * reads the graph. `entry.ts` decides cheaply whether anything new was edited
 * and loads this module only when something was.
 *
 * Agents never call Ix on their own, and context handed to them up front did
 * not change whether they solved an issue. This pushes one fact into the loop
 * at the moment it matters: right after an edit, who calls or imports what was
 * just changed, and which tests reach it -- the other places the fix may have
 * to touch.
 *
 * It must never get in the agent's way. Any failure -- no backend, an unmapped
 * workspace, a file the graph does not hold, a non-code file, a slow answer --
 * prints nothing and exits 0. `IX_HOOK_DEBUG=1` says why on stderr.
 */

export interface PatchHunk {
  oldStart: number;
  oldLines?: number;
  newStart: number;
  newLines?: number;
  lines: string[];
}

/** The fields of Claude Code's PostToolUse input this hook reads. */
export interface PostToolUseInput {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    edits?: Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>;
    content?: string;
  };
  tool_response?: {
    filePath?: string;
    type?: string;
    originalFile?: string | null;
    structuredPatch?: PatchHunk[];
  } | null;
}

export interface HookOptions {
  /** The mapped workspace to query, when the agent edits a different checkout of it. */
  graphRoot?: string;
  /** The root the agent's `file_path` is under; mapped onto `graphRoot`. */
  worktree?: string;
  budget?: number;
  env?: NodeJS.ProcessEnv;
}

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
/** Where a `new_string` occurs more often than this, it says nothing about where the edit was. */
const MAX_OCCURRENCES = 3;

/** Runs of consecutive line numbers as ranges. */
function toRanges(lines: number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: LineRange[] = [];
  for (const l of sorted) {
    const last = out[out.length - 1];
    if (last && l === last.end + 1) last.end = l;
    else out.push({ start: l, end: l });
  }
  return out;
}

/**
 * The lines a patch changed, on one side of it.
 *
 * `old`: the removed lines, in the file before the edit, plus each pure
 * insertion as the pair of old lines it went between. `new`: the added lines
 * in the file after it, plus each pure deletion as the pair it closed up.
 */
export function patchRanges(hunks: PatchHunk[], side: "old" | "new"): LineRange[] {
  const changed: number[] = [];
  const gaps: LineRange[] = [];
  for (const h of hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    let removedInRun = false;
    let addedInRun = false;
    for (const line of h.lines ?? []) {
      const c = line[0];
      if (c === "-") {
        if (side === "old") changed.push(o);
        removedInRun = true;
        o++;
      } else if (c === "+") {
        if (side === "new") changed.push(n);
        else if (!removedInRun && !addedInRun) gaps.push({ start: Math.max(1, o - 1), end: Math.max(1, o), insertion: true });
        addedInRun = true;
        n++;
      } else if (c === "\\") {
        continue;
      } else {
        if (side === "new" && removedInRun && !addedInRun) gaps.push({ start: Math.max(1, n - 1), end: Math.max(1, n), insertion: true });
        removedInRun = false;
        addedInRun = false;
        o++;
        n++;
      }
    }
    if (side === "new" && removedInRun && !addedInRun) gaps.push({ start: Math.max(1, n - 1), end: Math.max(1, n), insertion: true });
  }
  return [...toRanges(changed), ...gaps];
}

/** The line ranges `text` occupies in `content`, at most {@link MAX_OCCURRENCES} of them. */
export function locateText(content: string, text: string): LineRange[] {
  if (!text) return [];
  const variants = content.includes("\r\n") && !text.includes("\r\n") ? [text, text.replace(/\n/g, "\r\n")] : [text];
  for (const t of variants) {
    const out: LineRange[] = [];
    let from = 0;
    for (;;) {
      const at = content.indexOf(t, from);
      if (at < 0) break;
      const start = lineOf(content, at);
      const trimmed = t.replace(/\r?\n$/, "");
      out.push({ start, end: start + (trimmed.match(/\n/g)?.length ?? 0) });
      if (out.length > MAX_OCCURRENCES) return [];
      from = at + Math.max(1, t.length);
    }
    if (out.length > 0) return out;
  }
  return [];
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

export interface EditLocation {
  /** None: the whole file. */
  ranges?: LineRange[];
  /** The text `ranges` index into. */
  anchorLines: string[];
}

/**
 * Where the edit is, and in which text.
 *
 * The graph's spans were recorded before the edit, and the edit itself can
 * move or rename the declaration it changed. So the pre-edit side of the
 * patch is the anchor whenever the pre-edit text is there (`originalFile`):
 * the declaration the graph recorded is still in it, by its recorded name,
 * and the spans are re-anchored to that text for whatever earlier edits moved
 * it. When the edit runs in a different checkout from the graph's, this is
 * the only side that matches the graph at all. Without the pre-edit text the
 * new side is used, re-anchored to the file as it is now -- the same step
 * `ix around` takes for a line typed by hand.
 *
 * Undefined means there is nothing to report on: a new file, a no-op write,
 * an edit whose text cannot be found.
 */
export function locateEdit(input: PostToolUseInput, current: string): EditLocation | undefined {
  const tool = input.tool_name ?? "";
  const resp = input.tool_response ?? undefined;
  const currentLines = current.split("\n");
  if (tool === "Write" && resp?.type === "create") return undefined;

  const hunks = Array.isArray(resp?.structuredPatch) ? resp!.structuredPatch! : undefined;
  if (hunks && hunks.length > 0) {
    if (typeof resp?.originalFile === "string") {
      const ranges = patchRanges(hunks, "old");
      return ranges.length > 0 ? { ranges, anchorLines: resp.originalFile.split("\n") } : undefined;
    }
    const ranges = patchRanges(hunks, "new");
    return ranges.length > 0 ? { ranges, anchorLines: currentLines } : undefined;
  }

  if (tool === "Write") {
    // An empty patch on an update is a write that changed nothing; with no
    // response at all, all that is known is that the whole file was written.
    if (resp && hunks) return undefined;
    return { anchorLines: currentLines };
  }

  const ti = input.tool_input ?? {};
  const news = tool === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.new_string ?? "") : [ti.new_string ?? ""];
  const ranges = news.flatMap((t) => locateText(current, t));
  return ranges.length > 0 ? { ranges, anchorLines: currentLines } : undefined;
}

export interface HookDeps {
  gather?: (req: AroundRequest) => Promise<AroundResult>;
  readFile?: (abs: string) => string | undefined;
  /** A file's content in HEAD; the default asks git. */
  showHead?: (repoRoot: string, repoPath: string) => string | undefined;
  /** Moves the read scope to a directory; the default is `process.chdir`. */
  chdir?: (dir: string) => void;
  workspaceRoot?: () => string;
  debug?: (msg: string) => void;
}

/** What one run told the agent, and what it now counts as told. */
export interface HookOutcome {
  /** The stdout to print, if any. */
  output?: string;
  /** `path#id` keys of the symbols this run covered: shown, or found to have no dependents. */
  reported: string[];
  /** False when edited symbols were left for a later call by the symbol cap. */
  complete: boolean;
  /** What happened to each file and symbol, for `IX_HOOK_LOG`. */
  notes?: string[];
}

const NOTHING: HookOutcome = { reported: [], complete: true };
/** Changed files looked at per run; a diff touching more is mostly not code anyway. */
const MAX_FILES = 8;
/** Symbols reported per run, across all files. */
const MAX_SYMBOLS = 3;
const LEAD = "Ix: you changed";

/**
 * Rows the hook prints per symbol. In 93 recorded runs the first caller
 * listed was a file the fix changed 24 times in 61, later ones 5 in 51, and
 * no test row ever was (agents are told not to edit tests), so the hook shows
 * the nearest two callers and users and one test, and counts the rest.
 */
export const HOOK_CAPS = { symbols: 3, callers: 2, users: 2, tests: 1, importers: 5 };
const FOOTER = "These may need updating to match your edit.";

function defaultReadFile(abs: string): string | undefined {
  try {
    // One descriptor for the checks and the read, so the file measured is the
    // file read (CodeQL js/file-system-race).
    const fd = fs.openSync(abs, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
      return fs.readFileSync(fd, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const isInside = (rel: string) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);

interface Roots {
  /** Where the agent's files are. */
  worktree: string;
  /** The checkout the graph was built from. */
  graphRoot: string;
  /** The mapped workspace root (graph source_uris are relative to it). */
  workspaceRoot: string;
  /** The workspace root's counterpart in the worktree, for reading dependents' sites. */
  sourceRoot: string;
}

/** Every root in its canonical spelling (see `canonicalPath`), so they compare. */
function resolveRoots(worktree: string, opts: HookOptions, deps: HookDeps): Roots {
  const graphRoot = canonicalPath(opts.graphRoot ?? worktree);
  (deps.chdir ?? process.chdir)(graphRoot);
  const workspaceRoot = canonicalPath((deps.workspaceRoot ?? resolveWorkspaceRoot)());
  const root = canonicalPath(worktree);
  return {
    worktree: root,
    graphRoot,
    workspaceRoot,
    sourceRoot: path.join(root, path.relative(graphRoot, workspaceRoot)),
  };
}

/** A worktree file as the graph spells it, or undefined when it is outside the workspace or not code. */
function graphPath(roots: Roots, worktreeFile: string): string | undefined {
  const rel = path.relative(roots.worktree, canonicalPath(worktreeFile));
  if (!isInside(rel)) return undefined;
  const relPath = path.relative(roots.workspaceRoot, path.join(roots.graphRoot, rel)).split(path.sep).join("/");
  return isInside(relPath) && isSourcePath(relPath) ? relPath : undefined;
}

function gatherWith(deps: HookDeps, opts: HookOptions): (req: AroundRequest) => Promise<AroundResult> {
  if (deps.gather) return deps.gather;
  const timeoutMs = hookTimeoutMs(opts.env);
  return (req) => gatherAround(createClient({ deadlineSignal: AbortSignal.timeout(timeoutMs) }), req);
}

/**
 * The context for a set of answers: one `Ix: you changed ...` block per file,
 * the budget shared by symbol count, one closing line.
 */
export function renderHookText(results: AroundResult[], budget: number): string {
  const total = results.reduce((n, r) => n + r.symbols.length, 0);
  const room = Math.max(40, budget - Math.ceil(FOOTER.length / 4) - 1);
  const render = (x: AroundResult) => renderAroundText(x, { lead: LEAD });
  const fit = (r: AroundResult, tokens: number) => render(fitToBudget(r, render, tokens));
  // Each file gets its share by symbol count; what a small answer leaves
  // unused goes to the next one that was cut.
  const blocks = results.map((r) => fit(r, Math.max(30, Math.floor((room * r.symbols.length) / Math.max(1, total)))));
  let spare = room - blocks.reduce((n, b) => n + estimateTokens(b) + 1, 0);
  for (let i = 0; i < blocks.length && spare > 0; i++) {
    const used = estimateTokens(blocks[i]);
    const wider = fit(results[i], used + spare);
    spare -= estimateTokens(wider) - used;
    blocks[i] = wider;
  }
  return [...blocks, FOOTER].join("\n");
}

/**
 * Turn per-file answers into what to print and what to remember. A symbol
 * with no dependents counts as told (there is nothing to tell); one with
 * dependents past the cap does not, so a later call reports it.
 */
export function summarize(results: AroundResult[], budget: number): HookOutcome {
  const reported: string[] = [];
  const notes: string[] = [];
  const shown: AroundResult[] = [];
  let slots = MAX_SYMBOLS;
  let complete = true;
  for (const r of results) {
    const keep = [];
    if (r.symbols.length === 0) notes.push(`${r.path}: ${r.excluded ? "already_reported" : "no_definition_covers"}`);
    for (const s of r.symbols) {
      const deps = s.callers.total + s.users.total + s.tests.total;
      if (deps === 0) { reported.push(symbolKey(r.path, s.id)); notes.push(`${r.path}#${s.name}: no_dependents`); continue; }
      if (slots === 0) { complete = false; continue; }
      slots--;
      keep.push(s);
      reported.push(symbolKey(r.path, s.id));
    }
    if (keep.length > 0) shown.push({ ...r, symbols: keep });
  }
  for (const r of shown) for (const s of r.symbols) notes.push(`${r.path}#${s.name}: reported`);
  if (shown.length === 0) return { reported, complete, notes };
  return { output: postToolUseOutput(renderHookText(shown, budget)), reported, complete, notes };
}

/**
 * The diff path: every tracked file changed against HEAD, located by its
 * hunks' old side in HEAD's text -- the text the graph indexed, and what an
 * unedited `--graph-root` checkout holds -- and re-anchored from there.
 * Symbols in `already` are skipped. Never throws.
 */
export async function reportChangedFiles(
  ctx: { repoRoot: string; files: FileDiff[]; already: Set<string> },
  opts: HookOptions = {},
  deps: HookDeps = {},
): Promise<HookOutcome> {
  const debug = deps.debug ?? (() => {});
  try {
    const roots = resolveRoots(opts.worktree ?? ctx.repoRoot, opts, deps);
    const read = deps.readFile ?? defaultReadFile;
    const showHead = deps.showHead ?? gitShowHead;
    const gather = gatherWith(deps, opts);
    const files = new SourceFiles(roots.sourceRoot);

    const requests: AroundRequest[] = [];
    for (const f of ctx.files) {
      if (requests.length >= MAX_FILES) break;
      if (!f.oldPath) continue; // new file: nothing in the graph
      const relPath = graphPath(roots, path.join(ctx.repoRoot, f.oldPath));
      if (!relPath) { debug(`skip ${f.oldPath}`); continue; }
      const head = showHead(ctx.repoRoot, f.oldPath);
      if (head === undefined) continue;
      const current = f.newPath ? read(path.join(ctx.repoRoot, f.newPath)) ?? "" : "";
      const exclude = new Set([...ctx.already].filter((k) => k.startsWith(`${relPath}#`)).map((k) => k.slice(relPath.length + 1)));
      requests.push({
        relPath, ranges: f.oldRanges, anchorLines: head.split("\n"), currentLines: current.split("\n"), files, exclude,
        caps: HOOK_CAPS,
      });
      debug(`${relPath} old-side ${JSON.stringify(f.oldRanges)}`);
    }
    if (requests.length === 0) return NOTHING;
    const settled = await Promise.allSettled(requests.map((r) => gather(r)));
    const results = settled.flatMap((s, i) => {
      if (s.status === "fulfilled") return [s.value];
      debug(`${requests[i].relPath}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
      return [];
    });
    return summarize(results, opts.budget ?? DEFAULT_TOKEN_BUDGET);
  } catch (err) {
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return NOTHING;
  }
}

/**
 * Outside a git repository there is no diff, and only an Edit / MultiEdit /
 * Write says what changed: located from its own patch, the pre-edit side when
 * the pre-edit text is there (see {@link locateEdit}). Never throws.
 */
export async function reportToolEdit(
  input: PostToolUseInput, already: Set<string>, opts: HookOptions = {}, deps: HookDeps = {},
): Promise<HookOutcome> {
  const debug = deps.debug ?? (() => {});
  try {
    if (!EDIT_TOOLS.has(input.tool_name ?? "")) { debug(`tool ${input.tool_name} is not an edit`); return NOTHING; }
    const filePathRaw = input.tool_input?.file_path ?? input.tool_response?.filePath;
    if (!filePathRaw) { debug("no file_path"); return NOTHING; }
    const base = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
    const filePath = path.resolve(base, filePathRaw);
    const roots = resolveRoots(opts.worktree ?? path.dirname(filePath), opts, deps);
    const relPath = graphPath(roots, filePath);
    if (!relPath) { debug(`${filePath} is outside the workspace or not a source file`); return NOTHING; }

    const current = (deps.readFile ?? defaultReadFile)(filePath)
      ?? (typeof input.tool_input?.content === "string" ? input.tool_input.content : undefined);
    if (current === undefined) { debug(`cannot read ${filePath}`); return NOTHING; }
    const where = locateEdit(input, current);
    if (!where) { debug("edit not located"); return NOTHING; }

    const exclude = new Set([...already].filter((k) => k.startsWith(`${relPath}#`)).map((k) => k.slice(relPath.length + 1)));
    const result = await gatherWith(deps, opts)({
      relPath, ranges: where.ranges, anchorLines: where.anchorLines, currentLines: current.split("\n"),
      files: new SourceFiles(roots.sourceRoot), exclude, caps: HOOK_CAPS,
    });
    if (!hasDependents(result)) debug("no dependents");
    return summarize([result], opts.budget ?? DEFAULT_TOKEN_BUDGET);
  } catch (err) {
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return NOTHING;
  }
}
