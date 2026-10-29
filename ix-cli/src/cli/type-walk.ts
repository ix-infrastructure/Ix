// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";
import { mapLimit } from "../client/request-memo.js";
import { ALL_CONCURRENCY, DISPATCH_DEPTH, DISPATCH_MAX_TYPES, TYPE_KINDS, byName } from "./commands/callers.js";
import { SourceFiles } from "./edge-sites.js";
import { expandCapped, rowLocation } from "./format.js";

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
 * expand and one member expand.
 */
export const HIERARCHY_MAX_REQUESTS = 1 + (1 + HIERARCHY_UP_MAX_TYPES) + 2 * HIERARCHY_MAX_TYPES;

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
  const open: string[] = [];
  let out = "";
  for (const ch of text) {
    if (ch === "(" || ch === "<") open.push(ch);
    else if (ch === ")" && open.includes("(")) {
      while (open.pop() !== "(") { /* unwind any `<` left open inside the parens */ }
    } else if (ch === ">" && open[open.length - 1] === "<") open.pop();
    else if (open.length === 0) out += ch;
  }
  return out;
}

/** Whether a type's header line visibly names a base: the graph may predate heritage capture. */
export function headerDeclaresBase(lines: readonly string[], lineStart: number, path: string): boolean {
  // The header up to its body: a few lines at most.
  const header = lines.slice(Math.max(0, lineStart - 1), lineStart + 2).join(" ").split(/[{]/)[0];
  if (/\.pyi?$/i.test(path)) {
    const bases = /\bclass\s+\w+\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/.exec(header)?.[1]?.trim();
    return !!bases && !/^(object)?$/.test(bases);
  }
  if (/\.rb$/i.test(path)) return /\bclass\s+[\w:]+\s*<\s*\S/.test(header);
  if (/\.(kt|kts|cs|swift|cpp|cc|cxx|c\+\+|hpp|hh|hxx|h)$/i.test(path)) {
    // Constructor parameters and generic arguments carry colons of their own.
    const bare = outsideBrackets(header);
    return /\b(class|struct|interface|object|record|enum|protocol)\s+\w+[^:;]*?:\s*[\w:]/.test(bare);
  }
  return /\b(extends|implements)\b/.test(header);
}

/**
 * The override family of one method. Requests are bounded by
 * `HIERARCHY_MAX_REQUESTS`, at most `ALL_CONCURRENCY` per walk and two walks at
 * once: about 3 for a class with no heritage, about a dozen for a typical
 * family.
 */
export async function overrideFamily(
  client: Pick<IxClient, "expand">,
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
  const [{ found: up, ownerHasBase }] = await Promise.all([
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
  // The farthest declaration; among equals, the first in walk order (by name).
  const root = declaring.reduce<typeof declaring[number] | undefined>((best, u) => (!best || u.depth > best.depth ? u : best), undefined);

  // Siblings: from the root down, around the owner's own subtree.
  const siblings = new Map<string, number>();
  if (root) {
    await walkDown(root.type, subtypesOf, types, caps,
      (t) => t.id === owner.id || below.has(t.id),
      (t, depth) => { if (!ancestors.has(t.id)) siblings.set(t.id, depth); });
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
  const via = root ? `${root.type.name}.${target.name}` : undefined;
  for (const [id, depth] of siblings) add(id, "sibling", depth, via);
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
  if (!ownerHasBase && ownerLocation.path && ownerLocation.lineStart !== undefined) {
    const lines = files.lines(ownerLocation.path);
    if (lines && headerDeclaresBase(lines, ownerLocation.lineStart, ownerLocation.path)) {
      diagnostics.push({
        code: "heritage_not_in_graph",
        message: `${owner.name} declares a base type in ${ownerLocation.path}:${ownerLocation.lineStart}, but the graph has no ` +
          "EXTENDS edge for it. The map may predate heritage capture, or the base did not resolve; re-map with: ix map",
      });
    }
  }

  return {
    owner: { ...typeRef(owner), ...(ownerLocation.path ? { path: ownerLocation.path } : {}) },
    ...(root ? { root: via } : {}),
    rows,
    truncated: caps.size > 0,
    diagnostics,
  };
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
async function walkUp(owner: any, expand: Expand, caps: Set<HierarchyCap>): Promise<{ found: Array<{ type: any; depth: number }>; ownerHasBase: boolean }> {
  const seen = new Set<string>([owner.id]);
  const found: Array<{ type: any; depth: number }> = [];
  let ownerHasBase = false;
  let frontier = [owner];
  for (let depth = 1; frontier.length > 0; depth++) {
    const parents = await mapLimit(frontier, ALL_CONCURRENCY, (t) => expand(t.id, "out", "EXTENDS"));
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
  return { found, ownerHasBase };
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
