// Copyright 2026 Ix Infrastructure Inc.

// Bundle assembly: turn resolved facts, backend context and budgets into one
// bounded, deterministic `ContextBundle`.

import { BUNDLE_SCHEMA } from "../context-bundle-schema.js";
import type { StructuredContext } from "../../client/types.js";
import type { EntityLocation } from "../explain/facts.js";
import { placeIssueMatches, rankIssueEntities } from "../explain/issue-entities.js";
import { createStaleProbe } from "../stale.js";
import { graphHealthJson, isUnhealthy } from "../graph-health.js";

import { locationFields, targetLocation } from "./location.js";
import type { BudgetSnapshot, BundleFormat } from "./options.js";
import { rankEvidence, LEADING_MEMBERS } from "./rank.js";
import { evidenceRecord } from "./records.js";
import { llmNextByCut, bundleLlmLines, textEvidenceLines, TEXT_HEADER_ESTIMATE } from "./render.js";
import { summariseCut } from "./truncation.js";
import type { EvidenceItem, ContextBundle, BuildInput } from "./types.js";
import { asString, cmp } from "./util.js";

/**
 * Hard cap on the conflict reports carried in a bundle. Not a `--max-*` flag:
 * the bundle reports the count it saw either way, and a caller who needs every
 * report wants `ix conflicts`, not a bigger context bundle.
 */
const MAX_CONFLICTS = 10;

export function buildBundle(input: BuildInput): ContextBundle {
  const { resolved, facts, context, provenance, budgets } = input;
  const format = input.format ?? "json";
  const issue = input.issue;
  const prov = provenanceSource(provenance);

  const gathered = gatherEntities(input);
  // Relationships: graph edges, ordered deterministically.
  const contextEdges = context.edges.length > 0 ? context.edges : (context.edgeSummaries ?? []);
  const relationships = [...contextEdges]
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.predicate, b.predicate))
    .map((edge) => ({ src: edge.src, dst: edge.dst, predicate: edge.predicate }));
  const entities = placeIssueEntities(input, gathered.entities, relationships, gathered.discoveredOnly);

  const evidence = rankEvidence({ resolved, facts, context, relationships, prov, entities, issue });

  const bundle = bundleShell(input, prov, format);
  budgetEntities(bundle, input, entities, relationships);
  budgetEvidence(bundle, evidence, budgets, format);
  capConflicts(bundle);
  return bundle;
}

/**
 * Every entity the bundle could carry, in the order the entity budget cuts
 * from, and the ids only the issue's listing found.
 */
function gatherEntities(input: BuildInput): { entities: ContextBundle["entities"]; discoveredOnly: Set<string> } {
  const { resolved, facts, context } = input;
  const issue = input.issue;
  const stale = facts.stale;
  // Entities: the target itself plus every referenced node, deduped by id and
  // ordered deterministically (kind, name, id) before budgeting.
  // `stale` here is the TARGET's staleness, from the facts collector. It is
  // right for the bundle-level `freshness`, but every other entity has to be
  // asked about separately — stamping the target's answer onto all of them
  // reported an untouched dependency as stale whenever the target was, and a
  // genuinely stale one as current whenever the target was not. Staleness is
  // the field an agent reads to decide whether to trust the rest, so a wrong
  // one is worse than none.
  const seen = new Set<string>([resolved.id]);
  const entities: ContextBundle["entities"] = [
    {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      ...locationFields(targetLocation(facts) ?? {}),
      stale,
    },
  ];
  // The entities the facts collector located, most relevant first: the
  // top-ranked members, then the named callers and dependents. They go ahead of
  // the backend's context nodes, which are ordered by kind and name, so the
  // entity budget cuts what matters least. They also carry the paths and lines
  // that the backend's node summaries do not.
  //
  // Only the leading members jump the queue. A large file has more members than
  // the whole entity budget -- `ingest.ts` in the Ix repo has over a hundred --
  // and putting all of them first crowded out the files it imports and is
  // imported by, which are what cross-file questions need. The rest follow the
  // context nodes.
  const memberRefs = facts.memberRefs ?? [];
  const pushLocated = (refs: EntityLocation[]) => {
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      entities.push({
        id: ref.id,
        name: ref.name,
        kind: ref.kind,
        // A package's provenance names the file that imports it, not the
        // package: `node:fs` came out located in `commands/watch.ts`.
        ...(ref.kind === "module" ? {} : locationFields(ref)),
        stale: false, // replaced below, for the entities that survive the budget
      });
    }
  };
  pushLocated(leadingRefs(input));
  // Compact and standard backend responses omit the full graph arrays and
  // carry the same graph as summaries. Falling back here keeps the default
  // context mode from collapsing to a target-only bundle.
  const contextNodes = contextNodeRefs(context);
  // The facts collector's own record of an entity wins over the backend's
  // summary of it. Backends up to at least 1.0.30 summarize a file's members
  // with the FILE's name and no path, so a member that reached the bundle
  // through the summaries -- ahead of its located ref, which `seen` then
  // skipped -- came out as twelve entities all named `watch.ts`.
  const trailingMembers = memberRefs.slice(LEADING_MEMBERS);
  const locatedById = new Map([...trailingMembers, ...(issue?.discoveredEntities ?? [])].map((ref) => [ref.id, ref]));
  const fileNames = new Set(
    [...contextNodes, resolved].filter((n) => n.kind === "file").map((n) => n.name));
  for (const node of orderedNodes(contextNodes)) {
    if (seen.has(node.id)) continue;
    const located = locatedById.get(node.id);
    if (located) {
      pushLocated([located]);
      continue;
    }
    // The same defect with no located ref to fall back on: a symbol with no
    // location, named after a file. Its name is wrong and it cannot be
    // opened, so it would only spend entity budget misleading the reader.
    if (!node.path && node.kind !== "file" && node.kind !== "module" && fileNames.has(node.name)) {
      continue;
    }
    seen.add(node.id);
    entities.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(node.kind === "module" || !node.path ? {} : { path: node.path }),
      stale: false, // replaced below, for the entities that survive the budget
    });
  }
  pushLocated(trailingMembers);
  // Unmatched discoveries must not evict graph context. Positive issue matches
  // are promoted within their reserved budget by placeIssueMatches below; the
  // ones that only the listing found, and that do not match, are dropped there.
  const discoveredOnly = new Set(
    (issue?.discoveredEntities ?? []).map((ref) => ref.id).filter((id) => !seen.has(id)));
  pushLocated(issue?.discoveredEntities ?? []);
  return { entities, discoveredOnly };
}

/** The located entities that go ahead of the backend's context nodes, most relevant first. */
function leadingRefs(input: BuildInput): EntityLocation[] {
  const { resolved, facts } = input;
  const issue = input.issue;
  const memberRefs = facts.memberRefs ?? [];
  return [
    // The issue's other starting points, right after the one the bundle is
    // centred on: they are as much the target as it is.
    ...(issue?.startingPoints ?? [])
      .filter((s) => s.id && s.id !== resolved.id)
      .map((s) => ({ id: s.id!, name: s.name, kind: s.kind, ...locationFields(s) })),
    ...memberRefs.slice(0, LEADING_MEMBERS),
    // What the target reaches, before what reaches it: an agent starting from
    // an entry point is looking for where to go next.
    ...(facts.importRefs ?? []),
    ...(facts.calleeRefs ?? []),
    // What those files define. Naming the file is half an answer to "which
    // function does X"; these are the other half.
    ...(facts.neighbourRefs ?? []),
    ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []),
    // Two steps out, ranked. After everything one step out, and ahead of the
    // backend's context nodes, which are ordered by kind and name only.
    ...(facts.relatedRefs ?? []),
    ...(issue?.extraEntities ?? []),
  ];
}

/** The backend's context nodes, from the full graph arrays or their summaries. */
function contextNodeRefs(context: StructuredContext) {
  return context.nodes.length > 0
    ? context.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: node.provenance?.sourceUri,
      }))
    : (context.nodeSummaries ?? []).map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: node.path ?? node.sourceUri ?? undefined,
      }));
}

/** With an issue, its matches placed within the entity budget; without one, the graph's entities alone. */
function placeIssueEntities(
  input: BuildInput,
  entities: ContextBundle["entities"],
  relationships: ContextBundle["relationships"],
  discoveredOnly: Set<string>,
): ContextBundle["entities"] {
  const { resolved, budgets } = input;
  const issue = input.issue;
  if (issue?.query !== undefined) {
    const pinned = new Set([resolved.id, ...issue.startingPoints.flatMap((s) => s.id ? [s.id] : [])]);
    // A listed definition that does not match the issue was never graph
    // context: keeping it would fill spare budget with score-0 noise and count
    // it as truncated content the bundle never had. One that matches only
    // words most of the listed definitions share scores 0 here too.
    return placeIssueMatches(
      entities,
      rankIssueEntities(entities, { ...issue, query: issue.query, listedOnly: discoveredOnly }, relationships),
      pinned, budgets.maxEntities)
      .filter((e) => e.score > 0 || !discoveredOnly.has(e.id));
  } else {
    return entities.filter((e) => !discoveredOnly.has(e.id));
  }
}

/** The bundle with its lists empty and nothing cut: the budgets below fill it. */
function bundleShell(input: BuildInput, prov: Record<string, unknown>, format: BundleFormat): ContextBundle {
  const { resolved, facts, context, asOfRev, depth, budgets } = input;
  const issue = input.issue;
  const stale = facts.stale;
  // Three states, not two. Without a completed source graph baseline the
  // backend may still answer from partially committed graph patches. It is not
  // `stale` either — nothing is known to have changed. The
  // freshness union has carried `unverified` for exactly this case since it was
  // written; this is the first thing to produce it.
  const graphCompleted = input.graphCompleted ?? true;
  // A hollowed graph outranks all three: "current" would vouch for a bundle
  // whose members and callers the graph has lost.
  const health = input.graphHealth;
  const degraded = isUnhealthy(health);
  const classification = degraded ? "degraded" : !graphCompleted ? "unverified" : stale ? "stale" : "current";
  return {
    schema: BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    target: {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      resolutionMode: resolved.resolutionMode,
      ...(facts.path ? { path: facts.path } : {}),
    },
    ...(issue
      ? {
          issue: { startingPoints: issue.startingPoints, unresolved: issue.unresolved, fallback: issue.fallback },
          rankedFiles: issue.rankedFiles,
        }
      : {}),
    entities: [],
    relationships: [],
    claims: [...context.claims]
      .sort(
        (a, b) =>
          cmp(a.claim.entityId, b.claim.entityId) ||
          cmp(a.claim.statement, b.claim.statement) ||
          cmp(a.claim.id, b.claim.id),
      )
      .map((scored) => ({
        id: scored.claim.id,
        entityId: scored.claim.entityId,
        statement: scored.claim.statement,
        status: scored.claim.status,
      })),
    decisions: [...context.decisions].sort((a, b) => cmp(a.title, b.title) || a.rev - b.rev || cmp(a.rationale, b.rationale)),
    conflicts: [...context.conflicts].sort((a, b) => cmp(a.claimA, b.claimA) || cmp(a.claimB, b.claimB) || cmp(a.id, b.id)),
    intents: [...context.intents].sort((a, b) => cmp(a.statement, b.statement) || cmp(a.id, b.id)),
    provenance: {
      sourceUri: asString(prov.sourceUri) ?? facts.path,
      sourceHash: asString(prov.sourceHash),
      extractor: asString(prov.extractor),
      sourceType: asString(prov.sourceType),
      observedAt: asString(prov.observedAt),
      introducedRev: facts.introducedRev,
      historyLength: facts.historyLength,
      stale,
    },
    freshness: { stale, classification },
    ...(degraded ? { graph: graphHealthJson(health) } : {}),
    evidence: [],
    budgets: { ...budgets, format },
    truncation: {
      entitiesTruncated: 0,
      relationshipsTruncated: 0,
      evidenceTruncated: 0,
      charactersTruncated: 0,
      conflictsTruncated: 0,
    },
    metadata: {
      asOfRev,
      depth,
      rankingRule: issue?.query !== undefined ? "issue-bm25" : "deterministic-tier",
    },
  };
}

/** Cut the entities to `--max-entities`, then the relationships to the entities that survived. */
function budgetEntities(
  bundle: ContextBundle,
  input: BuildInput,
  entities: ContextBundle["entities"],
  relationships: ContextBundle["relationships"],
): void {
  const { resolved, budgets } = input;
  // Apply budgets with explicit truncation metadata. Ordering is already
  // deterministic, so cutting from the tail is stable across runs.
  const entityLimit = Math.min(entities.length, budgets.maxEntities);
  // Probe staleness after budgeting, so the cost is bounded by maxEntities
  // rather than by however many nodes the context service returned. The target
  // keeps the answer the facts collector already produced for it.
  const probeStale = input.isStale ?? createStaleProbe();
  bundle.entities = entities.slice(0, entityLimit).map((entity) =>
    entity.id === resolved.id || !entity.path
      ? entity
      : { ...entity, stale: probeStale(entity.path) },
  );
  bundle.truncation.entitiesTruncated = entities.length - entityLimit;

  // Relationships are budgeted against the entities that SURVIVED, not against
  // the full list. The two budgets used to be applied independently, so an edge
  // could be kept while one or both of its endpoints were cut: measured on a
  // real target at `--max-entities 10`, 59 of 74 relationships referenced an
  // entity no longer in the bundle, 13 of them at both ends -- and
  // `relationshipsTruncated` reported 0, because nothing had exceeded the
  // relationship budget. The renderer prints those as bare UUIDs, so the damage
  // was invisible.
  //
  // The backend already guarantees this on its side (`trimSlice` keeps an edge
  // only when both endpoints survive); this stops the CLI from undoing it.
  // Dropping the dangling edge rather than pulling its endpoint back in keeps
  // `--max-entities` meaning exactly what it says.
  const keptEntityIds = new Set(bundle.entities.map((e) => e.id));
  const connected = relationships.filter(
    (r) => keptEntityIds.has(r.src) && keptEntityIds.has(r.dst),
  );
  const relLimit = Math.min(connected.length, budgets.maxRelationships);
  bundle.relationships = connected.slice(0, relLimit);
  // Count everything the caller does not get back, whichever budget cost it --
  // the entity cut and the relationship cut both drop relationships, and
  // reporting only the second is what made an 80%-dangling bundle look clean.
  bundle.truncation.relationshipsTruncated = relationships.length - relLimit;
}

/** Keep the longest evidence prefix that fits `--max-evidence` and the character budget. */
function budgetEvidence(bundle: ContextBundle, evidence: EvidenceItem[], budgets: BudgetSnapshot, format: BundleFormat): void {
  // Evidence is ordered by relevance, so keep the highest-priority prefix and
  // drop the tail when either the count or the character budget is exceeded.
  // Each item is sized by the text its renderer prints (the llm `evidence`
  // line, the two prose lines, or the item's JSON), so `--max-tokens` is
  // charged for what is emitted rather than for a serialization nobody sees.
  // For llm the header, diagnostics and `next` lines are charged too; for json
  // the budget bounds the evidence list only (entities and relationships have
  // their own count budgets).
  const sizeOf = (item: EvidenceItem): number =>
    format === "llm" ? evidenceRecord(undefined)(item).length + 1
      : format === "text" ? textEvidenceLines(item).reduce((sum, line) => sum + line.length + 1, 0)
        : JSON.stringify(item).length;
  const sizedEvidence = evidence.map((item) => ({ item, size: sizeOf(item) }));
  // keptSize[n] = summed size of the first n items, so a cut at any count knows
  // its `charactersTruncated` (full minus kept, in the sizing unit of the
  // format) without a rescan.
  const keptSize = [0];
  for (const entry of sizedEvidence) keptSize.push(keptSize[keptSize.length - 1]! + entry.size);
  const fullChars = keptSize[sizedEvidence.length]!;
  // Every counter the llm header prints is set here, including
  // `truncated_chars`, so each measurement below sees the digits that will
  // actually be emitted for that cut.
  const applyCut = (count: number): void => {
    bundle.evidence = evidence.slice(0, count);
    bundle.truncation.evidenceTruncated = evidence.length - count;
    bundle.truncation.charactersTruncated = fullChars - keptSize[count]!;
    const cut = summariseCut(evidence.slice(count));
    if (cut.length > 0) bundle.truncation.cut = cut;
    else delete bundle.truncation.cut;
  };
  // The llm output at the current cut, with the `next` rows looked up rather
  // than recomputed: this is measured once per fitting step.
  const nextAt = format === "llm" ? llmNextByCut(bundle, evidence) : undefined;
  const llmSize = (): number => bundleLlmLines(bundle, nextAt!(bundle.evidence.length)).join("\n").length;
  let overhead = 0;
  if (format === "llm") {
    applyCut(0);
    overhead = llmSize();
  } else if (format === "text") {
    overhead = TEXT_HEADER_ESTIMATE;
  }
  const evidenceBudget = budgets.maxChars - overhead;
  let chars = 0;
  let kept = 0;
  for (const entry of sizedEvidence) {
    // The first row is the target and always survives, however small the budget.
    if (kept >= budgets.maxEvidence || (kept > 0 && chars + entry.size > evidenceBudget)) break;
    chars += entry.size;
    kept += 1;
  }
  applyCut(kept);
  if (format === "llm") {
    // The header digits, the bundle_truncated diagnostic and the `next` lines
    // all depend on the cut, so settle it by measuring the real output.
    while (kept > 1 && llmSize() > budgets.maxChars) {
      kept -= 1;
      applyCut(kept);
    }
    // The overhead was measured with a truncation diagnostic reserved, which a
    // bundle that fits whole does not carry. Grow back while the real output
    // still fits.
    const limit = Math.min(sizedEvidence.length, budgets.maxEvidence);
    // A complete bundle drops the truncation diagnostic, so it can fit where
    // the nearly-complete ones do not: try the whole list before growing.
    if (kept < limit) {
      applyCut(limit);
      if (llmSize() <= budgets.maxChars) {
        kept = limit;
      } else {
        applyCut(kept);
      }
    }
    while (kept < limit) {
      applyCut(kept + 1);
      if (llmSize() > budgets.maxChars) {
        applyCut(kept);
        break;
      }
      kept += 1;
    }
  }
}

function capConflicts(bundle: ContextBundle): void {
  // `conflicts[]` was the one list with no budget at all, and it is the one the
  // backend can hand back by the dozen: it reached 12,922 of 23,030 JSON bytes
  // on a recorded bundle. The evidence budgets never bounded it because they
  // bound `evidence`. Cap it at a fixed depth -- a caller who wants the full
  // set has `ix conflicts`, which is the command that renders them properly.
  const conflictLimit = Math.min(bundle.conflicts.length, MAX_CONFLICTS);
  bundle.truncation.conflictsTruncated = bundle.conflicts.length - conflictLimit;
  bundle.conflicts = bundle.conflicts.slice(0, conflictLimit);
}

/**
 * The source record of a `/v1/provenance` response.
 *
 * The endpoint answers `{ entityId, chain: [{ rev, source: { uri, extractor,
 * ... } }] }`, and this used to read `sourceUri` and `extractor` off the top
 * level, where they never are -- so every bundle reported "provenance unknown,
 * extractor unknown". The newest chain entry is the one that describes the
 * current node. A flat record is still accepted as-is.
 */
function provenanceSource(provenance: unknown): Record<string, unknown> {
  const record = asRecord(provenance);
  const chain = Array.isArray(record.chain) ? record.chain.map(asRecord) : undefined;
  if (!chain) return record;
  if (chain.length === 0) return {};
  const latest = chain.reduce((a, b) =>
    (typeof b.rev === "number" ? b.rev : -Infinity) > (typeof a.rev === "number" ? a.rev : -Infinity) ? b : a);
  const source = asRecord(latest.source);
  return {
    sourceUri: source.uri ?? source.sourceUri,
    sourceHash: source.sourceHash,
    extractor: source.extractor,
    sourceType: source.sourceType,
    observedAt: latest.observedAt ?? source.observedAt,
  };
}

function orderedNodes<T extends { id: string; kind: string; name: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.id, b.id));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
