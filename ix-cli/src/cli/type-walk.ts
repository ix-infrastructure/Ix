// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";
import { mapLimit } from "../client/request-memo.js";
import { ALL_CONCURRENCY, DISPATCH_DEPTH, DISPATCH_MAX_TYPES, TYPE_KINDS, byName } from "./commands/callers.js";
import { SourceFiles } from "./edge-sites.js";
import { expandCapped, rowLocation } from "./format.js";
import { activeReadScope } from "./resolve.js";

/**
 * The other definitions of a method: the declarations it overrides or
 * implements, the overrides below it, and the sibling implementations of the
 * same base method. Read from `EXTENDS` (which carries `implements` too) and
 * `CONTAINS` edges, the same walk Java's `dispatchCallers` does upwards, here
 * in both directions and for every language.
 *
 * Every type is a graph id, never a name, so two same-named classes in
 * different files never merge; a type reached twice (a diamond, a cycle) is
 * looked at, and listed, once.
 */

/** Levels walked up from the owner, down from it, and down from the root. */
export const HIERARCHY_DEPTH = DISPATCH_DEPTH;
/** Supertypes looked at, at most. */
export const HIERARCHY_UP_MAX_TYPES = DISPATCH_MAX_TYPES;
/** Types looked at, at most, across every walk (the owner included). */
export const HIERARCHY_MAX_TYPES = 32;

/**
 * The most requests one target can cost: the owner lookup, then per type at
 * most one supertype expand (the owner and its supertypes only), one subtype
 * expand and one member expand. The heritage_not_in_graph lookups
 * (`HERITAGE_LOOKUPS`) run only for an owner with no supertype, whose up walk
 * cost one request instead of `1 + HIERARCHY_UP_MAX_TYPES`, so they fit.
 */
export const HIERARCHY_MAX_REQUESTS = 1 + (1 + HIERARCHY_UP_MAX_TYPES) + 2 * HIERARCHY_MAX_TYPES;

/** Base names looked up in the graph for heritage_not_in_graph, at most. */
export const HERITAGE_LOOKUPS = 4;

/** A supertype of one of these kinds is implemented, not overridden. */
const ABSTRACT_KINDS = new Set(["interface", "trait", "protocol"]);
const MEMBER_KINDS = /^(method|function)$/i;
/** Languages where one type can declare the same name several times. */
const OVERLOAD_LANGUAGES = /\.(java|kt|kts|cs|scala|sc|cpp|cc|cxx|c\+\+|hpp|hh|hxx|h)$/i;

export type OverrideRelation = "overrides" | "implements" | "overridden_by" | "sibling";
export type HierarchyCap = "depth" | "types" | "edges";

export interface TypeRef { id: string; name: string; kind: string }

export interface OverrideRow {
  name: string;
  kind: string;
  id: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  owner: TypeRef;
  relation: OverrideRelation;
  /** Levels from the target's type (up and down rows) or from the root (siblings). */
  depth: number;
  /** Siblings only: the root declaration they share, `Type.m`. */
  via?: string;
}

export interface HierarchyDiagnostic {
  code: "no_owner_type" | "hierarchy_truncated" | "overloads_not_distinguished" | "heritage_not_in_graph";
  message: string;
  /** hierarchy_truncated: the bound that stopped a walk. */
  cap?: HierarchyCap;
}

export interface OverrideFamily {
  /** The type that contains the target; absent for a free function. */
  owner?: TypeRef & { path?: string };
  /** The farthest supertype declaring the method, as `Type.m`; absent when none does. */
  root?: string;
  /**
   * Every top declaration, `root` first, when there are several: supertypes
   * declaring the method that no other declaring supertype is above (two
   * interfaces, or a base class and an interface). Siblings come from each.
   */
  roots?: string[];
  rows: OverrideRow[];
  /** A bound stopped a walk: there may be more rows than these. */
  truncated: boolean;
  diagnostics: HierarchyDiagnostic[];
}

const RELATION_ORDER: Record<OverrideRelation, number> = { overrides: 0, implements: 0, overridden_by: 1, sibling: 2 };
const CAP_ORDER: readonly HierarchyCap[] = ["depth", "types", "edges"];

const typeRef = (n: any): TypeRef => ({ id: String(n.id), name: String(n.name ?? ""), kind: String(n.kind ?? "") });

/**
 * `text` without its `(...)` and `<...>` runs, nesting included, in one pass.
 * A `>` closes only an open `<`, so `->` inside a parameter list is not a
 * bracket; a `)` closes back to its `(`. An unclosed run drops the rest of
 * the text: what follows it is inside the brackets as far as anyone can tell.
 */
export function outsideBrackets(text: string): string {
  return scanBrackets(text).out;
}

/** `outsideBrackets`, and whether a run is still open at the end of `text`. */
function scanBrackets(text: string): { out: string; open: boolean } {
  const open: string[] = [];
  let out = "";
  for (const ch of text) {
    if (ch === "(" || ch === "<") open.push(ch);
    else if (ch === ")" && open.includes("(")) {
      while (open.pop() !== "(") { /* unwind any `<` left open inside the parens */ }
    } else if (ch === ">" && open[open.length - 1] === "<") open.pop();
    else if (open.length === 0) out += ch;
  }
  return { out, open: open.length > 0 };
}

/**
 * A type's header, up to its body: the line at `lineStart` and at most two
 * more, which join only before the type keyword (annotation and decorator
 * lines) or while the header visibly goes on: a bracket still open, a
 * trailing `,`, `extends` or `implements` (or `:` outside Python, where it
 * opens the body), or a next line opening with `:`, `,`, `extends`,
 * `implements`, `where` or `permits`. A bodyless `data class P(val x: Int)`
 * ends on its own line, so a `fun f(): Config` below it is not read as a base.
 */
function headerText(lines: readonly string[], lineStart: number, path: string): string {
  const trailing = /\.pyi?$/i.test(path) ? /(?:,|\b(?:extends|implements))\s*$/ : /(?:[:,]|\b(?:extends|implements))\s*$/;
  let text = "";
  for (let i = Math.max(0, lineStart - 1); i < Math.min(lines.length, lineStart + 2); i++) {
    const line = lines[i] ?? "";
    if (text !== "") {
      const scan = scanBrackets(text);
      const started = /\b(?:class|struct|interface|object|record|enum|protocol|trait)\b/.test(scan.out);
      if (started && !scan.open && !trailing.test(text)
        && !/^\s*(?:[:,]|(?:extends|implements|where|permits)\b)/.test(line)) break;
    }
    text += (text === "" ? "" : " ") + line;
    if (line.includes("{")) break;
  }
  return text.split(/[{]/)[0];
}

/**
 * The bases a type's header line visibly names, each by its last name segment
 * (`models.Model` is `Model`, `ns::Base` is `Base`), in order, once each.
 * Generic arguments, constructor parameters and keyword arguments are not bases.
 */
export function headerBaseNames(lines: readonly string[], lineStart: number, path: string): string[] {
  const header = headerText(lines, lineStart, path);
  let bases: string[];
  if (/\.pyi?$/i.test(path)) {
    let list = /\bclass\s+\w+\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/.exec(header)?.[1] ?? "";
    // `Generic[K, V]`, `Mapping[str, List[int]]`: subscripts, innermost first.
    for (let prev = ""; prev !== list;) { prev = list; list = list.replace(/\[[^[\]]*\]/g, ""); }
    // Keyword arguments (`metaclass=ABCMeta`, `**kw`), `*args` and `object` are not bases.
    bases = list.split(",").map((b) => b.trim())
      .filter((b) => b !== "" && b !== "object" && !b.startsWith("*") && !/^\w+\s*=/.test(b));
  } else if (/\.rb$/i.test(path)) {
    const base = /\bclass\s+[\w:]+\s*<\s*([\w:]+)/.exec(header)?.[1];
    bases = base ? [base] : [];
  } else if (/\.(kt|kts|cs|swift|cpp|cc|cxx|c\+\+|hpp|hh|hxx|h)$/i.test(path)) {
    // Constructor parameters and generic arguments carry colons of their own,
    // and so does a `where T : Bound` clause, which follows any base list.
    const bare = outsideBrackets(header).split(/\bwhere\b/)[0];
    const list = /\b(?:class|struct|interface|object|record|enum|protocol)\s+\w+[^:;]*?:\s*([\w:][^;]*)/.exec(bare)?.[1] ?? "";
    // C++ access and `virtual` specifiers; Kotlin delegation (`I by impl`) keeps `I`.
    bases = list.split(",").map((b) => b.trim().replace(/^(?:(?:public|protected|private|internal|virtual)\s+)+/, ""));
  } else {
    // Type parameter bounds (`<T extends Item>`) sit inside the brackets; a
    // Java `permits` list names subtypes, not bases.
    const bare = outsideBrackets(header).split(/\bpermits\b/)[0];
    const from = bare.search(/\b(?:extends|implements)\b/);
    bases = from < 0 ? [] : bare.slice(from).split(/\b(?:extends|implements)\b|,/).map((b) => b.trim());
  }
  const names = bases
    .map((b) => /^[\w$.:]+/.exec(b)?.[0].split(/\.|::/).filter(Boolean).pop())
    .filter((n): n is string => !!n);
  return [...new Set(names)];
}

/** Whether a type's header line visibly names a base. */
export function headerDeclaresBase(lines: readonly string[], lineStart: number, path: string): boolean {
  return headerBaseNames(lines, lineStart, path).length > 0;
}

/**
 * The override family of one method. Requests are bounded by
 * `HIERARCHY_MAX_REQUESTS`, at most `ALL_CONCURRENCY` per walk and two walks at
 * once: about 3 for a class with no heritage, about a dozen for a typical
 * family.
 */
export async function overrideFamily(
  client: Pick<IxClient, "expand" | "search">,
  target: { id: string; name: string; path?: string },
  files: { lines(path: string | undefined): string[] | null } = new SourceFiles(),
): Promise<OverrideFamily> {
  const caps = new Set<HierarchyCap>();
  const expand = async (id: string, direction: "in" | "out", predicate: string): Promise<any[]> => {
    const result = await client.expand(id, { direction, predicates: [predicate] });
    if (expandCapped(result)) caps.add("edges");
    return result.nodes.filter((n: any) => n?.id);
  };

  const owners = (await expand(target.id, "in", "CONTAINS"))
    .filter((n) => TYPE_KINDS.has(String(n.kind ?? "").toLowerCase()))
    .sort(byName);
  if (owners.length === 0) {
    return {
      rows: [], truncated: false,
      diagnostics: [{
        code: "no_owner_type",
        message: `${target.name} is not a member of a class, interface or trait in the graph, so nothing overrides it.`,
      }],
    };
  }
  const owner = owners[0];

  // Every type looked at, by id: the HIERARCHY_MAX_TYPES budget.
  const types = new Map<string, any>([[owner.id, owner]]);
  // Members named like the target, per type id.
  const members = new Map<string, any[]>();
  // Subtypes per type id: the sibling walk passes through types the owner walk already expanded.
  const subtypes = new Map<string, Promise<any[]>>();
  const subtypesOf = (t: any): Promise<any[]> => {
    if (!subtypes.has(t.id)) subtypes.set(t.id, expand(t.id, "in", "EXTENDS"));
    return subtypes.get(t.id)!;
  };
  const loadMembers = async (list: any[]): Promise<void> => {
    const need = list.filter((t) => !members.has(t.id));
    const found = await mapLimit(need, ALL_CONCURRENCY, (t) => expand(t.id, "out", "CONTAINS"));
    need.forEach((t, i) => members.set(t.id, found[i].filter((m) => m.name === target.name && MEMBER_KINDS.test(String(m.kind ?? "")))));
  };

  // Up: supertypes, nearest first. The owner's own members only where a second `m` can hide in it.
  const overloads = OVERLOAD_LANGUAGES.test(target.path ?? "");
  const [{ found: up, ownerHasBase, parentsOf }] = await Promise.all([
    walkUp(owner, expand, caps),
    overloads ? loadMembers([owner]) : undefined,
  ]);
  for (const { type } of up) types.set(type.id, type);

  // Members of the supertypes, while the owner's subtypes are walked. A
  // supertype that is also a subtype (an EXTENDS cycle) stays a supertype.
  const ancestors = new Set(up.map((u) => u.type.id));
  const below = new Map<string, number>();
  await Promise.all([
    loadMembers(up.map((u) => u.type)),
    walkDown(owner, subtypesOf, types, caps, (t) => ancestors.has(t.id), (t, depth) => below.set(t.id, depth)),
  ]);

  const declaring = up.filter((u) => (members.get(u.type.id) ?? []).length > 0);
  // The supertypes above one, through the EXTENDS edges the up walk read.
  const aboveOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    for (let todo = [id]; todo.length > 0;) {
      for (const p of parentsOf.get(todo.pop()!) ?? []) if (!seen.has(p)) { seen.add(p); todo.push(p); }
    }
    return seen;
  };
  const aboveDeclaring = new Map(declaring.map((d) => [d.type.id, aboveOf(d.type.id)]));
  // Top declarations: no other declaring supertype strictly above them (in a
  // cycle, each is above the other, and both stay). The farthest first; among
  // equals, the first in walk order (by name).
  const roots = declaring
    .filter((d) => !declaring.some((e) => e !== d && aboveDeclaring.get(d.type.id)!.has(e.type.id)
      && !aboveDeclaring.get(e.type.id)!.has(d.type.id)))
    .sort((a, b) => b.depth - a.depth);
  const qualify = (t: any) => `${t.name}.${target.name}`;

  // Siblings: from each root down, around the owner's own subtree, each
  // under the first root that reaches it. One root at a time, so the shared
  // types budget is spent in the same order on every run.
  const siblings = new Map<string, { depth: number; via: string }>();
  for (const root of roots) {
    await walkDown(root.type, subtypesOf, types, caps,
      (t) => t.id === owner.id || below.has(t.id),
      (t, depth) => { if (!ancestors.has(t.id) && !siblings.has(t.id)) siblings.set(t.id, { depth, via: qualify(root.type) }); });
  }
  if (roots.length > 0) {
    // A supertype the up walk did not reach (cut by a cap) shows up on the way
    // down from the root, above the owner or one of its supertypes: not a sibling.
    const above = new Set([owner.id, ...ancestors]);
    for (let grew = true; grew;) {
      grew = false;
      for (const id of [...siblings.keys()]) {
        const children = subtypes.has(id) ? await subtypes.get(id)! : [];
        if (children.some((c) => above.has(c.id))) {
          above.add(id);
          siblings.delete(id);
          grew = true;
        }
      }
    }
  }
  await loadMembers([...below.keys(), ...siblings.keys()].map((id) => types.get(id)));

  const rows: OverrideRow[] = [];
  const add = (typeId: string, relation: OverrideRelation, depth: number, via?: string) => {
    for (const m of members.get(typeId) ?? []) {
      if (m.id === target.id) continue;
      rows.push({
        name: String(m.name), kind: String(m.kind ?? ""), id: String(m.id), ...rowLocation(m),
        owner: typeRef(types.get(typeId)), relation, depth, ...(via ? { via } : {}),
      });
    }
  };
  for (const u of up) add(u.type.id, ABSTRACT_KINDS.has(String(u.type.kind ?? "").toLowerCase()) ? "implements" : "overrides", u.depth);
  for (const [id, depth] of below) add(id, "overridden_by", depth);
  for (const [id, { depth, via }] of siblings) add(id, "sibling", depth, via);
  rows.sort((a, b) => RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation]
    || a.depth - b.depth
    || String(a.path ?? "").localeCompare(String(b.path ?? ""))
    || (a.lineStart ?? 0) - (b.lineStart ?? 0)
    || a.id.localeCompare(b.id));

  const diagnostics: HierarchyDiagnostic[] = [];
  // In a fixed order: walks run side by side, so the order caps were hit in is not.
  for (const cap of CAP_ORDER.filter((c) => caps.has(c))) {
    diagnostics.push({ code: "hierarchy_truncated", cap, message: truncationMessage(cap) });
  }
  if (overloads) {
    const overloaded = [...members].filter(([, list]) => list.length > 1).map(([id]) => types.get(id)?.name).filter(Boolean).sort();
    if (overloaded.length > 0) {
      diagnostics.push({
        code: "overloads_not_distinguished",
        message: `${overloaded.join(", ")} declare${overloaded.length === 1 ? "s" : ""} ${target.name} more than once; ` +
          "rows match by name, not by signature, so check each one's parameters.",
      });
    }
  }
  const ownerLocation = rowLocation(owner);
  const unlinked = ownerHasBase ? undefined : await unlinkedBase(client, owner, ownerLocation, files);
  if (unlinked) {
    diagnostics.push({
      code: "heritage_not_in_graph",
      message: `${owner.name} declares ${unlinked} as a base in ${ownerLocation.path}:${ownerLocation.lineStart}, and ${unlinked} is a ` +
        `type in the graph, but there is no EXTENDS edge from ${owner.name} to it. The map may predate heritage capture ` +
        "(re-map with: ix map), or ingestion could not resolve this base.",
    });
  }

  return {
    owner: { ...typeRef(owner), ...(ownerLocation.path ? { path: ownerLocation.path } : {}) },
    ...(roots.length > 0 ? { root: qualify(roots[0].type) } : {}),
    ...(roots.length > 1 ? { roots: roots.map((r) => qualify(r.type)) } : {}),
    rows,
    truncated: caps.size > 0,
    diagnostics,
  };
}

/**
 * A base the owner's header names that is itself a type in the graph, when the
 * owner has no EXTENDS edge: the one case a re-map can fix. A base from a
 * library or the language (`Exception`, `models.Model`, `React.Component`) is
 * never ingested, so its edge is dropped on every map, and saying so on every
 * run would be noise. At most `HERITAGE_LOOKUPS` name searches, and only for a
 * type with no supertype, whose up walk cost one request.
 */
async function unlinkedBase(
  client: Pick<IxClient, "search">,
  owner: any,
  location: { path?: string; lineStart?: number },
  files: { lines(path: string | undefined): string[] | null },
): Promise<string | undefined> {
  if (!location.path || location.lineStart === undefined) return undefined;
  const lines = files.lines(location.path);
  if (!lines) return undefined;
  const names = headerBaseNames(lines, location.lineStart, location.path).slice(0, HERITAGE_LOOKUPS);
  if (names.length === 0) return undefined;
  const { workspaceId, systemId } = activeReadScope();
  const inGraph = await mapLimit(names, ALL_CONCURRENCY, async (name) => {
    try {
      const nodes = await client.search(name, { limit: 50, nameOnly: true, workspaceId, systemId });
      return (nodes as any[]).some((n) => n?.id !== owner.id && String(n?.name ?? "") === name
        && TYPE_KINDS.has(String(n?.kind ?? "").toLowerCase()));
    } catch {
      // No answer is not evidence of a stale map.
      return false;
    }
  });
  return names.find((_, i) => inGraph[i]);
}

function truncationMessage(cap: HierarchyCap): string {
  switch (cap) {
    case "depth": return `Stopped ${HIERARCHY_DEPTH} levels from the type; deeper types were not looked at.`;
    case "types": return `Stopped after ${HIERARCHY_MAX_TYPES} types (${HIERARCHY_UP_MAX_TYPES} supertypes); the rest of the hierarchy was not looked at.`;
    case "edges": return "The server cut an expand at its edge cap; some types or members may be missing.";
  }
}

type Expand = (id: string, direction: "in" | "out", predicate: string) => Promise<any[]>;

/**
 * Breadth-first up `EXTENDS`, nearest first and by name within a level, to
 * `HIERARCHY_DEPTH` levels and `HIERARCHY_UP_MAX_TYPES` types. The level past
 * the last is expanded only to tell a cut walk from a finished one.
 */
async function walkUp(owner: any, expand: Expand, caps: Set<HierarchyCap>): Promise<{
  found: Array<{ type: any; depth: number }>; ownerHasBase: boolean; parentsOf: Map<string, string[]>;
}> {
  const seen = new Set<string>([owner.id]);
  const found: Array<{ type: any; depth: number }> = [];
  // The supertype ids each expanded type names, cut-off ones included.
  const parentsOf = new Map<string, string[]>();
  let ownerHasBase = false;
  let frontier = [owner];
  for (let depth = 1; frontier.length > 0; depth++) {
    const parents = await mapLimit(frontier, ALL_CONCURRENCY, (t) => expand(t.id, "out", "EXTENDS"));
    frontier.forEach((t, i) => parentsOf.set(t.id, parents[i].map((n) => String(n.id))));
    if (depth === 1) ownerHasBase = parents[0].length > 0;
    const next: any[] = [];
    let stop = false;
    for (const n of parents.flat().sort(byName)) {
      if (seen.has(n.id)) continue;
      if (depth > HIERARCHY_DEPTH) { caps.add("depth"); stop = true; break; }
      if (seen.size > HIERARCHY_UP_MAX_TYPES) { caps.add("types"); stop = true; break; }
      seen.add(n.id);
      next.push(n);
      found.push({ type: n, depth });
    }
    if (stop || depth > HIERARCHY_DEPTH) break;
    frontier = next;
  }
  return { found, ownerHasBase, parentsOf };
}

/**
 * Breadth-first down `EXTENDS` from `start`, to `HIERARCHY_DEPTH` levels,
 * adding each new type to `types` while it is under `HIERARCHY_MAX_TYPES`.
 * A type `skip` names is neither reported nor walked through; one already in
 * `types` (a supertype on the way down from the root) is walked through
 * without spending the budget again.
 */
async function walkDown(
  start: any,
  subtypesOf: (t: any) => Promise<any[]>,
  types: Map<string, any>,
  caps: Set<HierarchyCap>,
  skip: (t: any) => boolean,
  report: (t: any, depth: number) => void,
): Promise<void> {
  const seen = new Set<string>([start.id]);
  let frontier = [start];
  for (let depth = 1; frontier.length > 0; depth++) {
    const children = await mapLimit(frontier, ALL_CONCURRENCY, subtypesOf);
    const next: any[] = [];
    let stop = false;
    for (const n of children.flat().sort(byName)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (skip(n)) continue;
      if (depth > HIERARCHY_DEPTH) { caps.add("depth"); stop = true; break; }
      if (!types.has(n.id)) {
        if (types.size >= HIERARCHY_MAX_TYPES) { caps.add("types"); stop = true; break; }
        types.set(n.id, n);
      }
      next.push(n);
      report(n, depth);
    }
    if (stop || depth > HIERARCHY_DEPTH) break;
    frontier = next;
  }
}
