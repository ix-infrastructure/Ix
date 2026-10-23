// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import { absoluteFromSourceUri, isReadablePath } from "./config.js";
import { rowLocation } from "./format.js";

/**
 * Where an edge happens: the call, or the import, rather than the entity at
 * the other end of it.
 *
 * `ix callers` used to answer with the caller's whole span — `ingestFiles
 * lines=1368-3683` is 2,315 lines to find one call in — and every agent that
 * got that answer spent its next turn grepping for the line. The graph cannot
 * say where the call is: core-ingestion folds every call from one scope to one
 * callee into a single CALLS relationship and emits it with empty attrs
 * (`patch-builder.ts`), and the backend's `/v1/expand` hands those attrs back
 * as they are. So the site is recovered here, off the file on disk, which the
 * CLI already reads for `ix read`: one read per distinct file, bounded to the
 * rows being printed.
 */
export interface EdgeSite {
  /** Workspace-relative path of the file the call or import is in. */
  path: string;
  /** 1-based line of the first site. */
  line: number;
  /** That line, trimmed, with up to two continuation lines of an open call. */
  snippet: string;
  /** Further sites in the same scope, capped at {@link MAX_ALSO}. */
  also?: number[];
}

/** The entity an edge query was asked about. */
export interface EdgeTarget {
  name: string;
  kind?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
}

/** Relations whose rows can carry a site. `contains` has nothing to point at. */
export type SiteRelation = "callers" | "callees" | "imports" | "imported-by";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_CHARS = 160;
const MAX_ALSO = 4;
/** How far past a span a site is still looked for when the span cannot be re-anchored. */
const SPAN_SLACK = 30;

export function isSiteRelation(relation: string): relation is SiteRelation {
  return relation === "callers" || relation === "callees" || relation === "imports" || relation === "imported-by";
}

/**
 * The identifier a call site spells: `Foo::bar` and `Foo.bar` are called as
 * `bar`, so that is what is searched for.
 */
export function bareName(name: string): string {
  const parts = name.split(/::|[.#/\\]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `name` as a whole identifier. `$` counts as an identifier character, as it does in JS. */
function wordRe(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

/** `name(`, `name<T>(`, `new Name`, and the member form `.name(` (which the first covers). */
function callRe(name: string): RegExp {
  const n = escapeRegExp(name);
  return new RegExp(`\\bnew\\s+${n}(?![\\w$])|(?<![\\w$])${n}\\s*(?:<[^()]*>)?\\s*\\(`);
}

const DEF_KEYWORDS = [
  "function", "def", "fn", "func", "class", "interface", "struct", "trait", "object",
  "enum", "type", "const", "let", "var", "val", "module", "record", "sub", "macro",
].join("|");

/**
 * A line that declares `name` with a keyword (`function name`, `def name`,
 * `const name`, Go's `func (r *T) name(`). Never a use of it.
 */
function keywordDeclRe(name: string): RegExp {
  const n = escapeRegExp(name);
  return new RegExp(
    `\\b(?:${DEF_KEYWORDS})\\s*\\*?\\s+${n}(?![\\w$])`
    + `|\\bfunc\\s*\\([^)]*\\)\\s*${n}\\s*\\(`,
  );
}

/**
 * Any line that looks like it declares `name`, including the keyword-less
 * method shorthand of a class body (`async name(x) {`). That form is only
 * trusted when the line opens a body or a parameter list, because without the
 * keyword it is otherwise indistinguishable from a bare call statement.
 */
function declRe(name: string): RegExp {
  const n = escapeRegExp(name);
  const keyword = keywordDeclRe(name).source;
  return new RegExp(
    `${keyword}`
    + `|^\\s*(?:(?:export|default|public|private|protected|internal|static|async|override|abstract|final|readonly|get|set|pub(?:\\([^)]*\\))?)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\(.*[{(,]\\s*$`,
  );
}

/**
 * How many lines look like they declare `name`, by the same test `anchorSpan`
 * re-anchors with. More than one means a re-anchor could land on the wrong
 * one; none means it has nothing to land on.
 */
export function countDeclarations(lines: string[], name: string): number {
  const def = declRe(name);
  let count = 0;
  for (const line of lines) if (def.test(line)) count++;
  return count;
}

const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*|#(?!include|import)|--|;)/;

/** The site's text: its line, plus the lines of a call left open across them. */
function snippetAt(lines: string[], index: number): string {
  let text = lines[index].trim();
  let depth = parenDepth(text);
  for (let next = index + 1; depth > 0 && next < lines.length && next <= index + 2; next++) {
    const more = lines[next].trim();
    text = `${text} ${more}`;
    depth += parenDepth(more);
  }
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
}

function parenDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

/**
 * The span as it is on disk now.
 *
 * Graph spans are from the last ingest, and a file edited since has moved
 * under them: on a live workspace `readableRoots` sat at `250-253` in the graph
 * and at 283 on disk. Scanning the stale span finds the wrong call or none.
 * The nearest line that declares the entity's name is taken as its start now,
 * and the span is shifted with it; a decorator or doc line recorded as the
 * start moves it by a line or two, which costs nothing. With no declaration in
 * sight the recorded span stands, and is trusted only if the name is still on
 * one of its first lines.
 */
export function anchorSpan(
  lines: string[], name: string, lineStart: number, lineEnd: number | undefined,
): { start: number; end: number; anchored: boolean } {
  const end = lineEnd ?? lineStart;
  const def = declRe(name);
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!def.test(lines[i])) continue;
    if (best < 0 || Math.abs(i + 1 - lineStart) < Math.abs(best + 1 - lineStart)) best = i;
  }
  if (best >= 0) {
    const delta = best + 1 - lineStart;
    return { start: lineStart + delta, end: end + delta, anchored: true };
  }
  const word = wordRe(name);
  for (let l = lineStart; l <= Math.min(lineStart + 2, lines.length); l++) {
    if (word.test(lines[l - 1] ?? "")) return { start: lineStart, end, anchored: true };
  }
  return { start: lineStart, end, anchored: false };
}

/**
 * Lines inside [from, to] (1-based, inclusive) that use `name`, calls first.
 *
 * Comment lines never count, and neither does a line that declares `name`: a
 * recursive function's own signature is not a call to it. When no line in the
 * range calls `name`, a bare use stands in — a callback passed by name, a type
 * reference — because REFERENCES edges are listed as callers too.
 */
export function findUses(lines: string[], name: string, from: number, to: number): number[] {
  const call = callRe(name);
  const word = wordRe(name);
  const def = keywordDeclRe(name);
  const calls: number[] = [];
  const refs: number[] = [];
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  for (let l = first; l <= last; l++) {
    const text = lines[l - 1];
    if (!word.test(text) || COMMENT_ONLY.test(text) || def.test(text)) continue;
    (call.test(text) ? calls : refs).push(l);
  }
  return calls.length > 0 ? calls : refs;
}

/** Statement shapes that bring a name in from elsewhere, across the languages Ix parses. */
const IMPORT_LINE = /^\s*(?:import\b|export\b.*\bfrom\b|from\s+\S+\s+import\b|use\s|using\s|#\s*(?:include|import)\b|require\b|include\b|extern\s+crate\b|@import\b)|\bfrom\s+['"]|\brequire\s*\(|\bimport\s*\(/;

/**
 * The keys an import of this entity spells, most specific first.
 *
 * A file is imported by its path, so `src/cli/config.ts` shows up as
 * `./config.js` or `cli.config`; `index.ts` is too common a stem to trust on
 * its own and is tried with its directory first. Anything else is imported by
 * its name.
 */
export function importKeys(name: string, kind: string | undefined, path: string | undefined): string[] {
  const isFile = (kind ?? "").toLowerCase() === "file";
  const source = isFile ? (path ?? name) : name;
  const segments = source.replace(/\\/g, "/").split("/").filter((s) => s !== "");
  const base = segments[segments.length - 1] ?? source;
  if (!isFile) return [base];
  const stem = base.replace(/\.[^.]+$/, "");
  const parent = segments[segments.length - 2];
  return parent ? [`${parent}/${stem}`, stem] : [stem];
}

/** Import lines in the file that name any of `keys`, trying the most specific key first. */
export function findImports(lines: string[], keys: string[]): number[] {
  for (const key of keys) {
    const re = new RegExp(`(?<![\\w$-])${escapeRegExp(key)}(?![\\w$-])`);
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (IMPORT_LINE.test(lines[i]) && re.test(lines[i])) hits.push(i + 1);
    }
    if (hits.length > 0) return hits;
  }
  return [];
}

/** Reads each file at most once per command, and only inside a readable workspace. */
export class SourceFiles {
  private readonly cache = new Map<string, string[] | null>();

  constructor(private readonly root?: string) {}

  lines(relPath: string | undefined): string[] | null {
    if (!relPath) return null;
    if (this.cache.has(relPath)) return this.cache.get(relPath)!;
    let lines: string[] | null = null;
    try {
      const abs = absoluteFromSourceUri(relPath, this.root);
      if (isReadablePath(abs, this.root)) {
        // One descriptor for the checks and the read, so the file measured is
        // the file read (CodeQL js/file-system-race).
        const fd = fs.openSync(abs, "r");
        try {
          const stat = fs.fstatSync(fd);
          if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
            lines = fs.readFileSync(fd, "utf-8").split("\n");
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      lines = null;
    }
    this.cache.set(relPath, lines);
    return lines;
  }
}

function toSite(path: string, lines: string[], hits: number[]): EdgeSite | undefined {
  if (hits.length === 0) return undefined;
  const [line, ...rest] = hits;
  return {
    path,
    line,
    snippet: snippetAt(lines, line - 1),
    also: rest.length > 0 ? rest.slice(0, MAX_ALSO) : undefined,
  };
}

/** Uses of `name` inside the scope of an entity, the scope re-anchored to the file on disk. */
function usesInScope(
  lines: string[], name: string,
  scope: { name: string; kind?: string; lineStart?: number; lineEnd?: number },
): number[] {
  if ((scope.kind ?? "").toLowerCase() === "file" || scope.lineStart === undefined) {
    return findUses(lines, name, 1, lines.length);
  }
  const span = anchorSpan(lines, bareName(scope.name), scope.lineStart, scope.lineEnd);
  const inside = findUses(lines, name, span.start, span.end);
  if (inside.length > 0 || span.anchored) return inside;
  return findUses(lines, name, span.start - SPAN_SLACK, span.end + SPAN_SLACK);
}

/**
 * The site of one edge row, or undefined when it cannot be found honestly.
 *
 * - callers:     the call to the target, inside the caller's span, in the caller's file
 * - callees:     the call to the row, inside the target's span, in the target's file
 * - imported-by: the import of the target, in the importing row's file
 * - imports:     the import of the row, in the target's file
 */
export function findEdgeSite(
  relation: SiteRelation, row: any, target: EdgeTarget, files: SourceFiles,
): EdgeSite | undefined {
  const rowName: string = row?.name || row?.attrs?.name || "";
  if (!rowName) return undefined;
  const loc = rowLocation(row);
  const rowScope = { name: rowName, kind: row?.kind, lineStart: loc.lineStart, lineEnd: loc.lineEnd };

  switch (relation) {
    case "callers": {
      const lines = files.lines(loc.path);
      return lines && loc.path ? toSite(loc.path, lines, usesInScope(lines, bareName(target.name), rowScope)) : undefined;
    }
    case "callees": {
      const lines = files.lines(target.path);
      return lines && target.path ? toSite(target.path, lines, usesInScope(lines, bareName(rowName), target)) : undefined;
    }
    case "imported-by": {
      const lines = files.lines(loc.path);
      return lines && loc.path ? toSite(loc.path, lines, findImports(lines, importKeys(target.name, target.kind, target.path))) : undefined;
    }
    case "imports": {
      const lines = files.lines(target.path);
      return lines && target.path ? toSite(target.path, lines, findImports(lines, importKeys(rowName, row?.kind, loc.path))) : undefined;
    }
  }
}

/**
 * Attach a `site` to each row whose edge can be located on disk.
 *
 * Returns new row objects; the input is left alone. Rows with no findable
 * site come back unchanged, so a file that is missing, outside the workspace,
 * or edited past recognition costs a field, never a row.
 */
export function withEdgeSites(
  rows: any[], relation: string, target: EdgeTarget, opts: { root?: string; files?: SourceFiles } = {},
): any[] {
  if (!isSiteRelation(relation)) return rows;
  const files = opts.files ?? new SourceFiles(opts.root);
  return rows.map((row) => {
    let site: EdgeSite | undefined;
    try {
      site = findEdgeSite(relation, row, target, files);
    } catch {
      site = undefined;
    }
    return site ? { ...row, site } : row;
  });
}

/**
 * The target as the site finder needs it.
 *
 * `callers` and `imported-by` look in the rows' files and need only the
 * target's name. `callees` and `imports` look in the target's own file —
 * `callees` inside its span, which the resolver does not carry — so those cost
 * a `/v1/entity` read (~20 ms) whenever the resolver left out what they need:
 * the span of a non-file target, or the path of a target resolved by id.
 */
export async function edgeTargetFor(
  client: { entity(id: string): Promise<{ node: any }> },
  target: { id: string; name: string; kind: string; path?: string },
  relation: string,
): Promise<EdgeTarget> {
  const base: EdgeTarget = { name: target.name, kind: target.kind, path: target.path };
  const isFile = (target.kind ?? "").toLowerCase() === "file";
  const needsSpan = relation === "callees" && !isFile;
  const needsPath = (relation === "callees" || relation === "imports") && !base.path;
  if (!needsSpan && !needsPath) return base;
  try {
    const { node } = await client.entity(target.id);
    const loc = rowLocation(node);
    return {
      ...base,
      path: base.path ?? loc.path,
      lineStart: needsSpan ? loc.lineStart : undefined,
      lineEnd: needsSpan ? loc.lineEnd : undefined,
    };
  } catch {
    return base;
  }
}

/**
 * Order raw text matches of `name` the way a callers answer should read: calls
 * first, then other uses, then comments, with the name's own declaration
 * dropped — it is where the name is defined, not a caller of it. Stable within
 * each group, so ripgrep's file order survives.
 */
export function rankTextUses<T extends { snippet: string }>(matches: T[], name: string): T[] {
  const bare = bareName(name);
  const call = callRe(bare);
  const decl = keywordDeclRe(bare);
  const group = (text: string): number => (COMMENT_ONLY.test(text) ? 2 : call.test(text) ? 0 : 1);
  return matches
    .filter((m) => !decl.test(m.snippet))
    .map((m, i) => ({ m, i, g: group(m.snippet) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map(({ m }) => m);
}
