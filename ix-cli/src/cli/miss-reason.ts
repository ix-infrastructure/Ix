// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IxClient } from "../client/api.js";
import { currentRunSignal } from "../client/run-signal.js";
import { resolveWorkspaceRoot } from "./config.js";
import { SKIPPED_DIRS, isGeneratedFile, isSupportedSourceFile } from "./file-discovery.js";
import { isFileStale } from "./stale.js";
import type { TextMatch } from "./text-matches.js";

const execFileAsync = promisify(execFile);

/** Files whose graph state is looked up; each costs one search. */
const FILES_CHECKED = 3;

/** `IX_MISS_PROBE=0` skips the probe (a tree too large for even one bounded rg). */
export const MISS_PROBE_ENV = "IX_MISS_PROBE";

/**
 * Wall time one run may spend on miss probes, all misses together. A
 * multi-target call with several misses in a large tree would otherwise pay
 * the rg walk once per miss; once the budget is spent, later misses are
 * reported plainly. Kept per run (`ix mcp` runs many in one process), and per
 * process outside one, where a process is one command.
 */
const PROBE_BUDGET_MS = 5_000;
const spentByRun = new WeakMap<AbortSignal, number>();
let spentOutsideRun = 0;

function probeTimeSpent(): number {
  const run = currentRunSignal();
  return run ? spentByRun.get(run) ?? 0 : spentOutsideRun;
}

function chargeProbeTime(ms: number): void {
  const run = currentRunSignal();
  if (run) spentByRun.set(run, (spentByRun.get(run) ?? 0) + ms);
  else spentOutsideRun += ms;
}

/** A file `ix map` would hand to the parser: the only kind the graph can lack for a reason `ix map` fixes. */
function isParsedFile(file: string): boolean {
  return isSupportedSourceFile(file) && !isGeneratedFile(path.posix.basename(file));
}

function normalizeForPathMatch(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

export interface SymbolMissReason {
  /**
   * `symbol_file_not_indexed`  the name is in a file the graph does not have
   * `symbol_not_extracted`     the name is in indexed files, as no entity
   * `symbol_not_in_source`     the name is in no file of the workspace either
   */
  reason: "symbol_file_not_indexed" | "symbol_not_extracted" | "symbol_not_in_source";
  message: string;
  /** Workspace-relative files the name appears in (at most three). */
  files?: string[];
  /**
   * Every file the name appears in, any kind, with its first matching line,
   * in path order: from the same rg run, so they cost nothing more. A command
   * answers with the source ones (text-matches.ts).
   */
  matches?: TextMatch[];
  /** The fix is `ix map`: a file that mentions the name is unindexed, or changed since. */
  remap?: boolean;
}

/**
 * Why a symbol that resolved to nothing is not in the graph, when the
 * workspace's text can say.
 *
 * "No entity found" alone sends an agent to grep, which either finds the name
 * (and the agent concludes Ix is broken) or does not (and it wasted a call).
 * One bounded `rg -l` answers which of those it is before the agent asks: the
 * name is in a file the graph never indexed, in an indexed file as something
 * the parser does not extract, or nowhere at all.
 *
 * Best effort: no ripgrep, a timeout, or a failed search is `null`, and the
 * miss is reported as it always was.
 */
export async function explainSymbolMiss(
  client: Pick<IxClient, "search">,
  symbol: string,
  scope: { path?: string; workspaceId?: string; systemId?: string },
): Promise<SymbolMissReason | null> {
  if (!missProbeWouldRun(symbol)) return null;
  const left = PROBE_BUDGET_MS - probeTimeSpent();
  const name = probedName(symbol);

  let root: string;
  try { root = resolveWorkspaceRoot(); } catch { return null; }

  const started = Date.now();
  try {
    return await probe(client, symbol, name, root, scope, left);
  } finally {
    chargeProbeTime(Date.now() - started);
  }
}

/** The last segment of `Class.method` / `pkg::name`: that is the token in the text. */
function probedName(symbol: string): string {
  return symbol.split(/::|[.#]/).filter(Boolean).pop() ?? "";
}

/**
 * Whether `explainSymbolMiss` would look at all: the probe is on, this run's
 * budget is not spent, and the target is a name rg can search for. A caller
 * that pays for its own lookup before the probe checks this first.
 */
export function missProbeWouldRun(symbol: string): boolean {
  if (process.env[MISS_PROBE_ENV] === "0") return false;
  if (PROBE_BUDGET_MS - probeTimeSpent() <= 0) return false;
  return /^[A-Za-z_$][\w$]*$/.test(probedName(symbol));
}

/**
 * rg skips dot-directories unless told otherwise, but `ix map` parses
 * `.storybook/`, `.github/scripts/` and the like; only the dot-directories it
 * skips too (`.git`, `.venv`, `.next`, ...) stay out of the search.
 */
const RG_SCOPE_ARGS: readonly string[] = [
  "--hidden",
  ...[...SKIPPED_DIRS].filter((dir) => dir.startsWith(".")).flatMap((dir) => ["-g", `!${dir}/`]),
];

async function probe(
  client: Pick<IxClient, "search">,
  symbol: string,
  name: string,
  root: string,
  scope: { path?: string; workspaceId?: string; systemId?: string },
  timeoutMs: number,
): Promise<SymbolMissReason | null> {
  const matches = await filesMentioning(name, root, scope.path, timeoutMs);
  if (matches === null) return null;
  const hits = matches.map((m) => m.path);
  if (hits.length === 0) {
    return {
      reason: "symbol_not_in_source",
      message: `No entity found matching "${symbol}", and "${name}" does not appear in any file under ${scope.path ? `paths matching "${scope.path}"` : "the workspace"} either.`,
    };
  }

  // A README or a .txt that mentions the name is no file the graph lacks:
  // `ix map` never parses it. Only the name in no parsed file at all is left
  // as a plain miss.
  const files = hits.filter(isParsedFile);
  if (files.length === 0) return null;

  // Every checked file is looked up before judging: one unindexed file among
  // indexed ones does not make re-mapping the answer.
  const checked = files.slice(0, FILES_CHECKED);
  const nodes = await Promise.all(checked.map((file) => graphFile(client, file, scope)));
  const indexed: Array<{ file: string; rev?: number; stale: boolean }> = [];
  checked.forEach((file, i) => {
    if (!nodes[i]) return;
    let stale = false;
    try { stale = isFileStale(path.join(root, file)); } catch { /* unknown is not stale */ }
    indexed.push({ file, rev: revOf(nodes[i]), stale });
  });
  if (indexed.length === 0) {
    if (nodes.some((n) => n === undefined)) return null;
    return {
      reason: "symbol_file_not_indexed",
      message: `"${symbol}" is not in the graph, but it appears in ${checked[0]}, which has not been indexed: ` +
        "run `ix map`, or the file is ignored.",
      files: checked,
      matches,
      remap: true,
    };
  }

  const first = indexed[0];
  const where = `${first.file}${first.rev !== undefined ? ` (indexed at rev ${first.rev})` : " (indexed)"}`;
  const more = files.length > 1 ? ` and ${files.length - 1} other file${files.length === 2 ? "" : "s"}` : "";
  const stale = indexed.find((f) => f.stale);
  return {
    reason: "symbol_not_extracted",
    message: `"${symbol}" is not in the graph. It appears in ${where}${more}, but no entity by that name was extracted: ` +
      (stale
        ? `${stale.file} changed after it was indexed, so run \`ix map\` and retry.`
        : "it may be a local, a string, or a construct the parser does not index; `ix text` finds the occurrences."),
    files: checked,
    matches,
    ...(stale ? { remap: true } : {}),
  };
}

/**
 * Characters kept on each side of the name in a matching line. rg prints
 * only that window (`-o`), so the name is in the snippet however far along a
 * long line it sits (a preview of the line's first bytes can miss it), and a
 * minified file cannot fill the buffer.
 */
const SNIPPET_CONTEXT = 70;

/**
 * A safety cap on a printed window; the window itself is shorter unless the
 * name is very long.
 */
const RG_MAX_COLUMNS = "300";

/**
 * `-F -w name`, as a pattern that matches the window around it: `name` as a
 * word (what `-w` means: no word character either side), with up to
 * SNIPPET_CONTEXT characters before and after. The name is an identifier
 * (`missProbeWouldRun`), so `$` is the only character to escape.
 */
export function windowPattern(name: string): string {
  const word = name.replace(/\$/g, "\\$&");
  return `.{0,${SNIPPET_CONTEXT}}(?:^|\\W)${word}(?:\\W|$).{0,${SNIPPET_CONTEXT}}`;
}

/**
 * Workspace-relative files containing `name` as a word, each with its first
 * matching line, sorted by path; null when rg could not answer.
 *
 * `-m 1` stops reading a file at its first matching line, as `-l` did, so the
 * walk costs what it cost before; `--null` ends each path with a NUL, so a
 * path with a colon in it still splits from its line number. `-o` prints the
 * window around each match on that line: the first is kept.
 */
async function filesMentioning(name: string, root: string, pathFilter: string | undefined, timeoutMs: number): Promise<TextMatch[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("rg", [
      "-n", "-m", "1", "--null", "--no-heading", "--with-filename", "-o", "--max-columns", RG_MAX_COLUMNS, "--max-columns-preview",
      ...RG_SCOPE_ARGS, "-e", windowPattern(name), "--", root,
    ], {
      maxBuffer: 4 * 1024 * 1024, timeout: Math.min(5_000, timeoutMs), signal: currentRunSignal(),
    }));
  } catch (err) {
    const failure = err as { code?: unknown; stdout?: string };
    // rg exits 1 for "no matches": that is an answer.
    if (failure.code === 1 && !failure.stdout) return [];
    return null;
  }
  const filter = pathFilter ? normalizeForPathMatch(pathFilter) : "";
  const out: TextMatch[] = [];
  const seen = new Set<string>();
  for (const row of stdout.split("\n")) {
    const nul = row.indexOf("\0");
    if (nul < 0) continue;
    const rest = row.slice(nul + 1);
    const colon = rest.indexOf(":");
    const line = Number(rest.slice(0, colon));
    if (colon < 0 || !Number.isInteger(line)) continue;
    const rel = path.relative(root, row.slice(0, nul)).split(path.sep).join("/");
    if (filter && !normalizeForPathMatch(rel).includes(filter)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ path: rel, line, snippet: rest.slice(colon + 1).replace(/\r$/, "") });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const FILE_SEARCH_LIMIT = 50;

/**
 * The graph's node for a workspace-relative file: null when the graph has
 * none, undefined when that cannot be told (the search failed, or its window
 * came back full without the file -- a basename shared by more files than the
 * window holds proves nothing about this one).
 *
 * The path goes to the backend as `scope`, applied before the limit, so the
 * window holds only files at that path. A backend too old to know `scope`
 * ignores it, and the full-window rule above keeps the answer honest there.
 */
async function graphFile(
  client: Pick<IxClient, "search">,
  file: string,
  scope: { workspaceId?: string; systemId?: string },
): Promise<any | null | undefined> {
  try {
    const nodes = await client.search(path.posix.basename(file), {
      limit: FILE_SEARCH_LIMIT, kind: "file", nameOnly: true, scope: file,
      workspaceId: scope.workspaceId, systemId: scope.systemId,
    });
    const want = normalizeForPathMatch(file);
    const found = (nodes as any[]).find((n) => {
      const uri = normalizeForPathMatch(n?.provenance?.sourceUri ?? n?.provenance?.source_uri ?? "");
      return uri === want || uri.endsWith(`/${want}`);
    });
    if (found) return found;
    return nodes.length >= FILE_SEARCH_LIMIT ? undefined : null;
  } catch {
    return undefined;
  }
}

function revOf(node: any): number | undefined {
  const rev = node?.createdRev ?? node?.created_rev ?? node?.rev;
  return typeof rev === "number" ? rev : undefined;
}
