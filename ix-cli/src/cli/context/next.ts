// Copyright 2026 Ix Infrastructure Inc.

// Next-step planning: the `ix read` commands and MCP tool calls a bundle
// suggests, and whether each target file changed since the last ingest.

import { resolveWorkspaceRoot } from "../config.js";
import { symbolReadChecker } from "../symbol-read-check.js";
import { suggest, toolCall } from "../next-step.js";

import type { EvidenceItem, ContextBundle } from "./types.js";

/** One suggested read: the command, and whether its file changed since the last ingest. */
export interface NextRead {
  cmd: string;
  stale: boolean;
}

/**
 * A name or path a shell passes through unquoted and unsplit. No `$` (it
 * expands), no leading `#` (it starts a comment) and no leading `-` (it reads
 * as an option); anything else falls back to the range form.
 */
const SHELL_SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const SHELL_SAFE_PATH = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/;

/** Whether `ix read <name> --path <file>` reads `name` and nothing else; see `readsOneSymbol`. */
export type SymbolReadCheck = (name: string, path: string) => boolean;

/**
 * One on-disk check per workspace root (`symbolReadChecker`: one workspace
 * walk, each row's answer kept), shared by every bundle rendered against that
 * root within SYMBOL_CHECK_TTL_MS. Keyed on the root, not the bundle object,
 * so a render that sizes several copies of a bundle (a budget-fitting loop
 * measuring prefixes) still walks once. The short lifetime keeps a long-lived
 * `ix mcp` process from answering from a stale walk after files change.
 */
const SYMBOL_CHECK_TTL_MS = 5_000;

const symbolChecksByRoot = new Map<string, { check: SymbolReadCheck; at: number }>();

/** `readsOneSymbol` against this workspace's files, as they are on disk now, memoised per root. */
export function onDiskSymbolCheck(): SymbolReadCheck {
  // Lazy: the workspace root is resolved only when a stale row asks, so a
  // bundle with no stale rows never loads workspace config for this.
  let check: SymbolReadCheck | undefined;
  return (name, path) => (check ??= checkerForRoot(resolveWorkspaceRoot()))(name, path);
}

function checkerForRoot(root: string): SymbolReadCheck {
  const now = Date.now();
  const cached = symbolChecksByRoot.get(root);
  if (cached && now - cached.at < SYMBOL_CHECK_TTL_MS) return cached.check;
  const check = symbolReadChecker(root);
  symbolChecksByRoot.set(root, { check, at: now });
  return check;
}

/** The `next` rows renderBundle prints: `nextReads` with the on-disk check, cheap to call again. */
export function renderedNextReads(bundle: ContextBundle): NextRead[] {
  return nextReads(bundle, 3, onDiskSymbolCheck());
}

/**
 * The reads worth making next, most valuable first.
 *
 * The evidence rows carry `path:start-end` and the caller still has to decide
 * which of them to open — so the bundle ends by saying so, as commands rather
 * than coordinates. The saving this exists for is the whole-file read: on the
 * benchmark set one avoided 34-61k-character read is worth more than every
 * byte the bundle spends, and an agent handed a path with no range opens the
 * file.
 *
 * `stale` says the row's file changed since the last ingest, from the flags
 * the bundle already carries. There the range is from the last ingest and
 * points at the wrong lines, so a stale row that names a symbol is suggested
 * as `ix read <name> --path <file>`, which re-anchors to where the name is
 * declared on disk now. A fresh row keeps the range: it is exact, and it never
 * fails, where a symbol read can (live, `ix read add --path
 * core-ingestion/src/role-classifier.ts` exited 1: the resolver's name search
 * never returned that `add`). The range form also stays for a row with no
 * named symbol, a file or module, a name the shell would split, a name the
 * bundle shows twice in one file, and a name `symbolRead` rejects. The bundle's
 * entities are only the target's neighbours, so a second `save` in the same
 * file need not be among them: renderBundle passes `onDiskSymbolCheck`, which
 * asks the file itself (see `readsOneSymbol`), once per workspace root.
 *
 * Deduped, because a caller and a dependent are frequently the same function,
 * and taken in evidence order, which is already the ranking — the target first,
 * then its members, what it reaches, and what reaches it.
 */
export function nextReads(
  bundle: ContextBundle,
  limit = 3,
  symbolRead: SymbolReadCheck = () => true,
): NextRead[] {
  const rows = rowFreshness(bundle);
  const seen = new Set<string>();
  const reads: NextRead[] = [];
  for (const item of bundle.evidence) {
    const loc = item.location;
    if (!loc?.path || loc.lineStart === undefined || loc.lineEnd === undefined) continue;
    const range = `${loc.path}:${loc.lineStart}-${loc.lineEnd}`;
    if (seen.has(range)) continue;
    seen.add(range);
    const { stale, symbol } = rows(item, loc.path, symbolRead);
    reads.push({ cmd: symbol ? `ix read ${symbol} --path ${loc.path}` : `ix read ${range}`, stale });
    if (reads.length === limit) break;
  }
  return reads;
}

/**
 * For one evidence row at `path`: whether its file changed since the last
 * ingest, and, for a stale row, the symbol name `read <name> --path <path>`
 * re-anchors to — undefined wherever the range form must stand (see
 * {@link nextReads} for each condition). Shared by the CLI and MCP closes.
 */
function rowFreshness(
  bundle: ContextBundle,
): (item: EvidenceItem, path: string, symbolRead: SymbolReadCheck) => { stale: boolean; symbol?: string } {
  // `?? []`: a bundle restored from an older save, or built by hand, may carry
  // evidence alone.
  const entities = bundle.entities ?? [];
  const byId = new Map<string, { id: string; name: string; kind: string; path?: string; stale?: boolean }>();
  for (const e of entities) byId.set(e.id, e);
  const target = bundle.target;
  if (target?.id && !byId.has(target.id)) byId.set(target.id, target);
  const stalePaths = new Set<string>();
  for (const e of entities) if (e.stale && e.path) stalePaths.add(e.path);
  const sameNameInFile = new Map<string, number>();
  for (const e of byId.values()) {
    if (!e.path) continue;
    const key = `${e.path}\n${e.name}`;
    sameNameInFile.set(key, (sameNameInFile.get(key) ?? 0) + 1);
  }
  return (item, path, symbolRead) => {
    const ref = item.refs?.[0];
    const entity = ref ? byId.get(ref) : undefined;
    const stale = entity?.stale === true
      || stalePaths.has(path)
      || (path === target?.path && bundle.freshness?.stale === true);
    const kind = entity?.kind.toLowerCase();
    const named = stale
      && entity !== undefined
      && entity.name !== ""
      && kind !== "file"
      && kind !== "module"
      && entity.path === path
      && SHELL_SAFE_NAME.test(entity.name)
      && SHELL_SAFE_PATH.test(path)
      && sameNameInFile.get(`${path}\n${entity.name}`) === 1
      // Last: the only check that may touch the disk.
      && symbolRead(entity.name, path);
    return named ? { stale, symbol: entity.name } : { stale };
  };
}

/** One MCP next step; `stale` and `reanchor` appear only on a stale read (see {@link nextToolCalls}). */
export interface NextToolCall {
  cmd: string;
  why: string;
  stale?: true;
  reanchor?: string;
}

/** Longest range a suggested read may span; past it the read covers its head only. */
export const NEXT_READ_MAX_LINES = 120;

/**
 * The next calls worth making, for an MCP caller.
 *
 * {@link nextReads} closes a CLI bundle with `ix read path:a-b`, which over MCP
 * is the one suggestion an agent's own Read tool already covers — and the
 * recorded agents that did follow the bundle never once asked the graph the
 * questions only it answers. So the MCP close leads with those: who calls (or
 * imports) the target across files, and what a change to it reaches. A read of
 * the target's own range comes last, capped so a 558-line class does not turn
 * into a 558-line suggestion.
 *
 * Every call names core tools only, and pins the target's file with `path=` so
 * an ambiguous name resolves to the entity this bundle was built for.
 *
 * The read step carries `stale: true` when its file changed since the last
 * ingest (its range is from the last ingest), and then, if the symbol re-anchors
 * safely (the same checks as {@link nextReads}), `reanchor`: an `ix_read
 * symbol=<name> path=<file>` call that lands on where the name is now.
 */
export function nextToolCalls(
  bundle: ContextBundle,
  symbolRead: SymbolReadCheck = () => true,
): NextToolCall[] {
  const { name, kind, path } = bundle.target;
  const steps: NextToolCall[] = [];
  const isFile = kind.toLowerCase() === "file";
  // A file resolves by its path; a symbol by name, pinned to its file.
  const symbol = isFile ? (path ?? name) : name;
  const pin = isFile ? {} : { path };

  steps.push(
    isFile
      ? { cmd: suggest.neighbors(symbol, "imported_by", pin), why: "every file that imports this one" }
      : { cmd: suggest.neighbors(symbol, "callers", pin), why: "every call site across files, from the graph rather than a name match" },
  );
  steps.push({ cmd: suggest.impact(symbol, pin), why: "what a change here reaches, before you edit it" });

  const readItem = bundle.evidence.find(
    (item) => item.location?.path && item.location.lineStart !== undefined && item.location.lineEnd !== undefined,
  );
  const read = readItem?.location;
  if (readItem && read?.lineStart !== undefined && read.lineEnd !== undefined) {
    const end = Math.min(read.lineEnd, read.lineStart + NEXT_READ_MAX_LINES - 1);
    // Additive: the range call is unchanged; a stale file adds `stale` and,
    // where the name re-anchors safely, the symbol form beside it.
    const { stale, symbol } = rowFreshness(bundle)(readItem, read.path, symbolRead);
    steps.push({
      cmd: toolCall("ix_read", { symbol: `${read.path}:${read.lineStart}-${end}` }),
      why: end < read.lineEnd
        ? `first ${NEXT_READ_MAX_LINES} of ${read.lineEnd - read.lineStart + 1} lines of the top-ranked evidence`
        : "the top-ranked evidence",
      ...(stale ? { stale: true as const } : {}),
      ...(symbol ? { reanchor: toolCall("ix_read", { symbol, path: read.path }) } : {}),
    });
  }
  return steps;
}
