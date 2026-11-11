// Copyright 2026 Ix Infrastructure Inc.

// Evidence ranking: the tiered, scored rows a bundle shows, before budgets cut
// them.

import type { ConfidenceBreakdown, ScoredClaim, StructuredContext } from "../../client/types.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import { CLOSENESS_BOOST, START_BOOST } from "../explain/issue.js";
import type { RelatedRef } from "../explain/related-files.js";

import { locationFields, targetLocation, locationField, formatLocation } from "./location.js";
import type { EvidenceLocation, EvidenceItem, ContextBundle, IssueBundleInput } from "./types.js";
import { cmp } from "./util.js";

/**
 * Evidence tiers. A row's score is `tier * TIER_WIDTH + its place in the tier`,
 * so no tier can run into the next: structural rows were `10 + index`, and from
 * the eleventh on they interleaved with claims (20) and relationships (30+).
 */
const TIER = { target: 0, issue: 1, structural: 2, claims: 3, relationships: 4, provenance: 5 } as const;

const TIER_WIDTH = 1000;

const tierScore = (tier: number, index = 0): number => tier * TIER_WIDTH + Math.min(index, TIER_WIDTH - 1);

/** The six factors the backend multiplies into a claim's confidence. */
const CONFIDENCE_FACTORS = [
  "baseAuthority",
  "verification",
  "recency",
  "corroboration",
  "conflictPenalty",
  "intentAlignment",
] as const;

/**
 * A claim's confidence for its evidence reason, to two places: the product of
 * the six factor values in `confidence`, clamped to [0, 1]. That is the
 * backend's `ConfidenceBreakdown.score` (and `compactClaims[].confidence.score`),
 * which is not serialized in `claims[].confidence`, so reading
 * `confidence.score` printed "n/a" for every claim (#1007). `finalScore` is
 * not used here: it is relevance × confidence, and the reason already names
 * relevance on its own. "n/a" when any factor value is missing.
 */
function claimConfidence(scored: ScoredClaim): string {
  const breakdown = scored.confidence as Partial<ConfidenceBreakdown> | undefined;
  let product = 1;
  for (const name of CONFIDENCE_FACTORS) {
    const value = breakdown?.[name]?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
    product *= value;
  }
  return String(Math.round(Math.min(1, Math.max(0, product)) * 100) / 100);
}

/** What `rankEvidence` ranks. */
interface RankInput {
  resolved: { id: string; name: string; kind: string };
  facts: ContextFacts;
  context: StructuredContext;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  prov: Record<string, unknown>;
  entities: ContextBundle["entities"];
  issue?: IssueBundleInput;
}

/** Deterministic evidence ranking: tier, then a stable id tiebreaker. */
export function rankEvidence(input: RankInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];

  const target = input.resolved;
  items.push({
    id: `target:${target.id}`,
    kind: "target",
    source: "resolution",
    title: `${target.name} (${target.kind})`,
    score: 0,
    reason: "resolved target — the bundle is centered on this entity",
    refs: [target.id],
    ...locationField(targetLocation(input.facts)),
  });
  // Straight after the target, ahead of everything structural: a file target
  // with many members fills the default budget before score 10 runs out, and
  // these two rows are what `--from-issue` exists to deliver.
  if (input.issue) items.push(...issueEvidence(input.issue));

  // Each entity gets one row. The rows below are pushed in rank order, and a
  // row about something already shown is dropped (or, for a row that lists
  // several, loses that entry): the same file as an import and a dependent, or
  // a member restated by its CONTAINS edge, cost the budget twice for one fact.
  // The target is exempt -- every edge in the bundle touches it.
  const shown = new Set<string>([target.id]);
  for (const s of input.issue?.startingPoints ?? []) if (s.id) shown.add(s.id);
  const fresh = (id: string | undefined): boolean => id === undefined || !shown.has(id);
  const show = (ids: string[]) => { for (const id of ids) shown.add(id); };

  items.push(...structuralEvidence(input, fresh, show));
  items.push(...contextEvidence(input));
  items.push(...relationshipEvidence(input, fresh, show));

  items.push({
    id: `provenance:${target.id}`,
    kind: "provenance",
    source: "provenance + facts.history",
    title: `history length ${input.facts.historyLength}, introduced rev ${input.facts.introducedRev ?? "unknown"}`,
    score: tierScore(TIER.provenance),
    reason: `provenance ${input.prov.sourceType ?? "unknown"}, extractor ${input.prov.extractor ?? "unknown"}`,
    refs: [target.id],
  });

  // Stable full ordering: score, then id.
  return items.sort((a, b) => a.score - b.score || cmp(a.id, b.id));
}

type Structural = Omit<EvidenceItem, "kind" | "score">;

// Keyed by entity id, not name: two members called `render` were one id.
const rowId = (prefix: string, name: string, ref: EntityLocation | undefined) => `${prefix}:${ref?.id ?? name}`;

// Names alone when the facts carry no locations, so a caller that builds its
// own facts (or an older collector) still gets the structural evidence.
const related = (
  names: string[],
  refs: EntityLocation[] | undefined,
  limit: number,
): Array<{ name: string; ref?: EntityLocation }> =>
  (refs ? refs.map((ref) => ({ name: ref.name, ref })) : names.map((name) => ({ name }))).slice(0, limit);


/** The structural tier, in rank order: what holds the target, what it defines, what uses it, and what it reaches. */
function structuralEvidence(
  input: RankInput,
  fresh: (id: string | undefined) => boolean,
  show: (ids: string[]) => void,
): EvidenceItem[] {
  const structural: Structural[] = [];
  const pushOne = (item: Structural, ref: EntityLocation | undefined) => {
    if (!fresh(ref?.id)) return;
    if (ref) show([ref.id]);
    structural.push(item);
  };
  if (input.facts.container) {
    const container = input.facts.container;
    pushOne({
      id: rowId("container", container.name, container),
      source: "facts.container",
      title: `container ${container.name} (${container.kind})`,
      reason: "contains the target",
      refs: [container.id],
      ...locationField(container),
    }, container);
  }
  const leadingMembers = related(input.facts.members, input.facts.memberRefs, LEADING_MEMBERS);
  const pushMembers = (members: typeof leadingMembers) => {
    for (const { name, ref } of members) {
      pushOne({
        id: rowId("member", name, ref), source: "facts.members", title: `member ${name}`,
        reason: ref ? memberReason(ref) : "defined in the target", refs: ref ? [ref.id] : [], ...locationField(ref),
      }, ref);
    }
  };
  // The most-used members first, the rest last. A file target's evidence at
  // the default budget was the target and its first ten members and nothing
  // else -- the part of a bundle an agent sees anyway the moment it opens the
  // target. Measured on ix-bench, 0.55 of the expected files were in the
  // bundle and 0.32 in the text an agent is shown.
  pushMembers(leadingMembers.slice(0, MEMBERS_BEFORE_OUTWARD));
  // Two steps out: a neighbour's import, or a file that depends on what the
  // target depends on. Before the imports, which the target's own header
  // lists; these are the files a one-hop bundle cannot name at all.
  //
  // One row for all of them. As a row each, five related files cost as much
  // of the evidence budget as five imports, and at the default budget the
  // imports then fell off the end instead: the files moved, the count the
  // agent could see did not.
  const relatedRow = relatedFilesRow(input, fresh);
  if (relatedRow) {
    show(relatedRow.refs);
    structural.push(relatedRow);
  }
  // What uses the target: callers, then the dependents not already among them,
  // as one row whose title carries the total. Ahead of the imports and the
  // neighbours: as a row each, after them, they missed the default budget on
  // nearly every file target -- and they are what an edit has to keep working.
  const usedBy = usedByRow(input.facts, fresh);
  if (usedBy) {
    show(usedBy.refs);
    structural.push(usedBy);
  }
  // What happened to the target's file lately. The subjects carry what a
  // one-hop bundle cannot: that the sibling commands were already fixed for
  // the same condition, or that the same bug was fixed next door.
  const commitsRow = recentCommitsRow(input);
  if (commitsRow) structural.push(commitsRow);
  // Then outward. The file an answer lives in is most often one the target
  // imports: measured on the benchmark task set, 6 of 19 tasks' answers are a
  // direct import of their entry point, and none were in the bundle. These go
  // after the target's own members, not before: the evidence budget is 25
  // items, and a file with many imports (resolve.ts) pushed all 27 of its own
  // members out of the bundle entirely.
  for (const [item, ref] of outwardRows(input)) pushOne(item, ref);
  pushMembers(leadingMembers.slice(MEMBERS_BEFORE_OUTWARD));
  const items: EvidenceItem[] = [];
  structural.forEach((item, index) => {
    // Recent commits are provenance -- where the file's current shape came
    // from -- and keep to the stable kinds consumers already route on.
    items.push({
      ...item,
      kind: item.source === "git.history" ? "provenance" : "structural",
      score: tierScore(TIER.structural, index),
    });
  });
  return items;
}

/** One row naming every related file not already shown. */
function relatedFilesRow(input: RankInput, fresh: (id: string | undefined) => boolean): Structural | undefined {
  const relatedRefs = (input.facts.relatedRefs ?? []).filter((ref) => fresh(ref.id));
  if (relatedRefs.length === 0) return undefined;
  return {
    id: "related-files", source: "facts.related",
    title: `related files: ${relatedRefs.map((ref) => ref.path ?? ref.name).join(", ")}`,
    reason: `two steps from the target, ranked; ${relatedRefs.map(relatedClause).join("; ")}`,
    refs: relatedRefs.map((ref) => ref.id),
  };
}

/** One row of the target file's recent commits, newest first. */
function recentCommitsRow(input: RankInput): Structural | undefined {
  const commits = input.facts.recentCommits ?? [];
  if (commits.length === 0) return undefined;
  const file = (input.facts.path ?? "").split("/").pop();
  return {
    id: "recent-commits", source: "git.history",
    title: `recent commits to ${file}: ${commits.map((c) => `${c.sha} ${c.subject}`).join("; ")}`,
    reason: `newest first (${commits.map((c) => c.date).join(", ")}); \`git show <sha>\` for the change`,
    refs: [],
  };
}

/** The target's imports, then its callees, then what neighbouring files define, each with its entity. */
function outwardRows(input: RankInput): Array<[Structural, EntityLocation]> {
  const rows: Array<[Structural, EntityLocation]> = [];
  for (const ref of (input.facts.importRefs ?? []).slice(0, SHOWN_IMPORTS)) {
    rows.push([{
      id: rowId("imports", ref.name, ref), source: "facts.imports", title: `imports ${ref.name}`,
      reason: "the target imports this", refs: [ref.id], ...locationField(ref),
    }, ref]);
  }
  for (const ref of input.facts.calleeRefs ?? []) {
    rows.push([{
      id: rowId("calls", ref.name, ref), source: "facts.callees", title: `calls ${ref.name}`,
      reason: "the target calls this", refs: [ref.id], ...locationField(ref),
    }, ref]);
  }
  for (const ref of (input.facts.neighbourRefs ?? []).slice(0, SHOWN_NEIGHBOUR_MEMBERS)) {
    const where = ref.path ? ref.path.split("/").pop() : undefined;
    rows.push([{
      id: rowId("defines", ref.name, ref), source: "facts.neighbours",
      title: `${where ?? "a neighbouring file"} defines ${ref.name}`,
      reason: "defined in a file next to the target", refs: [ref.id], ...locationField(ref),
    }, ref]);
  }
  return rows;
}

/** Claims, decisions and intents, from the context service. */
function contextEvidence(input: RankInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  // Claims, decisions and intents share a tier, in that order; within each,
  // the id tiebreaker below orders them.
  for (const scored of input.context.claims) {
    items.push({
      id: `claim:${scored.claim.id}`,
      kind: "claim",
      source: "context.claims",
      title: scored.claim.statement,
      score: tierScore(TIER.claims, 0),
      reason: `context claim (relevance ${scored.relevance}, confidence ${claimConfidence(scored)})`,
      refs: [scored.claim.entityId],
    });
  }
  for (const decision of input.context.decisions) {
    items.push({
      id: `decision:${decision.title}`,
      kind: "decision",
      source: "context.decisions",
      title: decision.title,
      score: tierScore(TIER.claims, 1),
      reason: decision.rationale,
      refs: decision.entityId ? [decision.entityId] : [],
    });
  }
  // Conflicts are deliberately NOT evidence. A report names its two claims by
  // uuid, which is nothing an agent can act on, and ranked between decisions
  // and intents they outranked every relationship: on recorded bundles they
  // were taking 12 to 17 of the 25 slots and truncating away the members and
  // imports that answer the question. The count is carried in the bundle
  // header and the reports themselves stay in `conflicts[]` for a caller that
  // wants them; `ix conflicts` renders them.
  for (const intent of input.context.intents) {
    items.push({
      id: `intent:${intent.id}`,
      kind: "intent",
      source: "context.intents",
      title: intent.statement,
      score: tierScore(TIER.claims, 2),
      reason: `intent status ${intent.status}`,
      refs: [],
    });
  }
  return items;
}

function relationshipEvidence(
  input: RankInput,
  fresh: (id: string | undefined) => boolean,
  show: (ids: string[]) => void,
): EvidenceItem[] {
  const target = input.resolved;
  const items: EvidenceItem[] = [];
  // A relationship row is kept only when it names something no earlier row
  // does: `config.ts --CONTAINS--> getEndpoint` under a `member getEndpoint`
  // row restates it, and so does an edge to an entity an earlier edge named.
  const label = entityLabeller(input.entities);
  let relationshipIndex = 0;
  for (const edge of input.relationships.slice(0, 50)) {
    const ends = [...new Set([edge.src, edge.dst])].filter((id) => id !== target.id);
    if (ends.length === 0 || !ends.every((id) => fresh(id))) continue;
    show(ends);
    items.push({
      id: `relationship:${edge.src}:${edge.dst}:${edge.predicate}`,
      kind: "relationship",
      source: "context.edges",
      title: `${label(edge.src)} --${edge.predicate}--> ${label(edge.dst)}`,
      score: tierScore(TIER.relationships, relationshipIndex++),
      reason: "graph relationship from the context service",
      refs: [edge.src, edge.dst],
    });
  }
  return items;
}

/** Named callers and dependents shown in the "used by" row, at most. */
const SHOWN_USED_BY = 6;

/**
 * The one "used by" row: the target's callers, then its dependents that are not
 * already among them, each list ranked by the facts collector. The title says
 * how many of how many; `count` carries the same two numbers for a caller that
 * wants them without parsing.
 */
function usedByRow(
  facts: ContextFacts, fresh: (id: string | undefined) => boolean,
): Omit<EvidenceItem, "kind" | "score"> | undefined {
  const named = (names: string[], refs: EntityLocation[] | undefined) =>
    refs ?? names.map((name) => ({ id: "", name, kind: "unknown" }) as EntityLocation);
  const callers = named(facts.topCallers, facts.topCallerRefs);
  const dependents = named(facts.topDependents, facts.topDependentRefs);
  const picked: EntityLocation[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const ref of [...callers, ...dependents]) {
    if (picked.length >= SHOWN_USED_BY) break;
    // A name-only entry (no ref) is matched by name; a located one by id.
    if (ref.id ? ids.has(ref.id) || !fresh(ref.id) : names.has(ref.name)) continue;
    if (ref.id) ids.add(ref.id);
    names.add(ref.name);
    picked.push(ref);
  }
  if (picked.length === 0) return undefined;
  const total = Math.max(
    facts.usedByCount ?? Math.max(facts.callerCount, facts.dependentCount),
    picked.length,
  );
  const short = (ref: EntityLocation) => {
    const file = ref.path?.split("/").pop();
    return file && file !== ref.name ? `${ref.name} (${file})` : ref.name;
  };
  // Locations only: the title already names each entry and its file, and the
  // row is sized against the evidence budget like any other.
  const where = picked.filter((ref) => ref.path).map((ref) => formatLocation(locationFields(ref) as EvidenceLocation));
  const anyCaller = picked.some((ref) => callers.includes(ref));
  return {
    id: "used-by",
    // `facts.callers` when the row holds a caller, so a budget that cuts it
    // names `ix callers` as the way back; `ix impact` for dependents alone.
    source: anyCaller ? "facts.callers" : "facts.dependents",
    title: `used by (${picked.length} of ${total}): ${picked.map(short).join(", ")}`,
    reason: `calls, imports or references the target, most relevant first${where.length > 0 ? `; ${where.join(", ")}` : ""}`,
    refs: picked.flatMap((ref) => (ref.id ? [ref.id] : [])),
    count: { shown: picked.length, total },
    ...locationField(picked.find((ref) => ref.path)),
  };
}

/** Ranked files named in the evidence row; the JSON bundle carries the rest. */
const SHOWN_RANKED_FILES = 10;

/**
 * The `--from-issue` rows: where the bundle starts and why, then the files to
 * read, ranked against the issue's text.
 */
function issueEvidence(issue: IssueBundleInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const starts = issue.startingPoints;
  if (starts.length > 0) {
    const unresolved = issue.unresolved.length > 0
      ? `; unresolved: ${issue.unresolved.slice(0, 8).join(", ")}${issue.unresolved.length > 8 ? ", ..." : ""}`
      : "";
    const why = starts.map((s) => `${s.token}: ${s.via}`).join("; ");
    items.push({
      id: "issue-starts",
      kind: "target",
      source: "issue.starts",
      title: `starting points: ${starts.map((s) => `${s.name} (${formatLocation(locationFields(s) as EvidenceLocation)})`).join(", ")}`,
      score: tierScore(TIER.issue, 0),
      reason: (issue.fallback
        ? "no code name in the issue resolved to a definition; starting from the file BM25 ranks first against the issue text; "
        : "") + why + unresolved,
      refs: starts.flatMap((s) => (s.id ? [s.id] : [])),
      ...locationField(starts[0]),
    });
  }
  // Companions (issue-companions.ts) follow the whole primary list, past the
  // first SHOWN_RANKED_FILES once BM25 matches enough files: named after the
  // primary files shown, or text and llm output would never show one.
  const companions = issue.rankedFiles.filter((f) => f.companion);
  const shown = [...issue.rankedFiles.filter((f) => !f.companion).slice(0, SHOWN_RANKED_FILES), ...companions];
  if (shown.length > 0) {
    items.push({
      id: "issue-ranked-files",
      kind: "structural",
      source: "issue.ranking",
      title: `ranked files: ${shown.map((f) => f.path).join(", ")}`,
      score: tierScore(TIER.issue, 1),
      reason: `bm25 against the issue text, starting points boosted by up to ${Math.round(START_BOOST * 100)}% of the best bm25 score, graph neighbours of a starting point boosted up to ${Math.round(CLOSENESS_BOOST * 100)}%${companions.length > 0 ? ", then companion files of a leading file" : ""}; `
        + shown.map((f) => `${f.path.split("/").pop()} (${f.reason})`).join("; "),
      refs: [],
    });
  }
  return items;
}

/** Members placed ahead of the backend's context nodes; the evidence shows as many. */
export const LEADING_MEMBERS = 10;

/** Imports named in the evidence. The rest still enter the bundle as entities,
 * where they cost a line each and can carry the answer's file. */
const SHOWN_IMPORTS = 8;

/** Members of neighbouring files named in the evidence; the rest are entities. */
const SHOWN_NEIGHBOUR_MEMBERS = 6;

/** Members shown before anything outside the target; the rest close the list. */
const MEMBERS_BEFORE_OUTWARD = 5;

/** `rank.ts via listByKind, resolveWorkspaceId`, or just `rank.ts`. */
function relatedClause(ref: RelatedRef): string {
  const name = (ref.path ?? ref.name).split("/").pop();
  if (ref.named) return `${name} (${ref.named})`;
  return ref.via.length > 0 ? `${name} via ${ref.via.join(", ")}` : `${name} directly`;
}

function memberReason(ref: EntityLocation): string {
  if (ref.usedBy === undefined) return "defined in the target";
  if (ref.usedBy === 0) return "defined in the target; no recorded uses";
  const files = ref.usedFromFiles ?? 0;
  const where = files > 0 ? ` across ${files} other file${files === 1 ? "" : "s"}` : " within this file";
  return `defined in the target; used by ${ref.usedBy}${ref.usedByCapped ? "+" : ""}${where}`;
}

/**
 * Names for relationship endpoints. Relationship evidence used to print raw
 * ids -- `264cc04d-... --CONTAINS--> d1898d46-...` -- which an agent cannot use.
 * A name shared by two entities is qualified with its path, since several
 * files are routinely named `config.ts` or `README.md`; an id the bundle knows
 * nothing about stays an id.
 */
function entityLabeller(entities: ContextBundle["entities"]): (id: string) => string {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameCounts = new Map<string, number>();
  for (const e of entities) nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);
  return (id) => {
    const e = byId.get(id);
    if (!e) return id;
    return (nameCounts.get(e.name) ?? 0) > 1 && e.path ? `${e.name} (${e.path})` : e.name;
  };
}
