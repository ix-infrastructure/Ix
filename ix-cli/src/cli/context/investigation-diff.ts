// Copyright 2026 Ix Infrastructure Inc.

// `ix context --diff`: compare a saved investigation with a fresh build of the
// same target, and render the difference.

import { createClient } from "../../client/factory.js";
import { llmLine, llmShortId, printLlmLines } from "../llm.js";
import { activeReadScope, isRawId, resolveFileOrEntityFull, resolveFileOrReport, type ResolvedEntity } from "../resolve.js";
import { hasCompletedSourceGraphBaseline } from "../stale.js";
import { renderSection } from "../ui.js";
import { printJson } from "../format.js";
import { checkGraphHealth } from "../graph-health.js";

import { buildBundle } from "./bundle.js";
import { collectContextFacts, bundleGraphHealth } from "./collect.js";
import type { SavedInvestigation } from "./investigations.js";
import { type BudgetSnapshot, type BundleFormat, budgetFields, formatBudgets } from "./options.js";
import { entityRecord, evidenceRecord, claimRecord } from "./records.js";
import type { EvidenceItem, ContextBundle } from "./types.js";

export function diffInvestigations(
  saved: SavedInvestigation,
  fresh: ContextBundle,
  requestedBudgets?: Partial<BudgetSnapshot>,
): InvestigationDiff {
  const prev = saved.bundle;
  const addedEntities = fresh.entities.filter((e) => !prev.entities.some((p) => p.id === e.id));
  const removedEntities = prev.entities.filter((p) => !fresh.entities.some((e) => e.id === p.id));
  const addedRelationships = fresh.relationships.filter(
    (r) => !prev.relationships.some((p) => p.src === r.src && p.dst === r.dst && p.predicate === r.predicate),
  );
  const removedRelationships = prev.relationships.filter(
    (p) => !fresh.relationships.some((r) => r.src === p.src && r.dst === p.dst && r.predicate === p.predicate),
  );
  // Same id and same title. A row that summarises a set -- `used-by`,
  // `recent-commits`, `related-files` -- keeps its id while what it says
  // changes, and matched on id alone a new top caller or a total going from 3
  // to 40 was no change at all. A changed row is reported as removed and added.
  const sameEvidence = (a: EvidenceItem, b: EvidenceItem) => a.id === b.id && a.title === b.title;
  const addedEvidence = fresh.evidence.filter((e) => !prev.evidence.some((p) => sameEvidence(p, e)));
  const removedEvidence = prev.evidence.filter((p) => !fresh.evidence.some((e) => sameEvidence(p, e)));
  const addedClaims = fresh.claims.filter((c) => !prev.claims.some((p) => p.id === c.id));
  const removedClaims = prev.claims.filter((p) => !fresh.claims.some((c) => c.id === p.id));

  // Read off the bundle that was actually built, not restated from the
  // argument that built it. `{ ...saved.bundle.budgets }` would assert how the
  // fresh side was constructed rather than report it: today the two agree, but
  // letting CLI overrides win would mean editing the `buildFreshBundle` call in
  // the action handler, and `effective` would go on reporting the saved budget
  // while the fresh side used another one -- the silent misreport this record
  // exists to prevent. `ContextBundle.budgets` records the truth on both sides.
  const effective: BudgetSnapshot = { ...fresh.budgets };
  // Whether the caller's --max-* flags governed the fresh side.
  //
  // Not `requested equals effective`. Equal numbers are not evidence of
  // causation: `--max-evidence 25` against a saved budget of 25 produces
  // identical values while the flag changed nothing, and reporting `true` there
  // told an agent its override had taken -- so it raised the number, got the
  // saved budget again and now `false`. Three formats of one command disagreed,
  // because the note printed beside it said the opposite.
  //
  // What decides this is which budget the action handler hands
  // `buildFreshBundle`, and that is `saved.bundle.budgets` unconditionally, one
  // call site named in the comment there. So this is false, and the day that
  // call changes it is the day this needs to change with it.
  const requestedApplied = false;

  return {
    schema: "ix-investigation-diff/1",
    investigation: saved.id,
    savedAt: saved.savedAt,
    generatedAt: new Date().toISOString(),
    target: fresh.target,
    freshness: { previous: prev.freshness, current: fresh.freshness },
    budgets: {
      saved: saved.bundle.budgets,
      requested: requestedBudgets,
      effective,
      // The same fact the llm record carries as `applied=`. It was prose only
      // here, so a JSON consumer had to string-match a sentence whose wording
      // changed with the case, while the llm consumer got a boolean it could
      // test. One contract, both formats.
      requestedApplied,
      // Prose for the human reading the JSON, and only when there is something
      // to explain: without --max-* flags the sentence said nothing.
      ...(requestedBudgets
        ? {
            note: "Saved investigation budgets govern --diff; the --max-* flags recorded here were not applied to the fresh side.",
          }
        : {}),
    },
    added: {
      entities: addedEntities,
      relationships: addedRelationships,
      evidence: addedEvidence,
      claims: addedClaims,
    },
    removed: {
      entities: removedEntities,
      relationships: removedRelationships,
      evidence: removedEvidence,
      claims: removedClaims,
    },
  };
}

interface InvestigationDiff {
  schema: string;
  investigation: string;
  savedAt: string;
  generatedAt: string;
  target: ContextBundle["target"];
  freshness: { previous: ContextBundle["freshness"]; current: ContextBundle["freshness"] };
  budgets: {
    saved: BudgetSnapshot;
    requested?: Partial<BudgetSnapshot>;
    effective: BudgetSnapshot;
    /** Did `requested` govern the fresh side? The testable form of `note`. */
    requestedApplied: boolean;
    /** Present only when `requested` is: without it there is nothing to explain. */
    note?: string;
  };
  added: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
  removed: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
}

export function renderInvestigationDiff(
  saved: SavedInvestigation,
  fresh: ContextBundle,
  format: string,
  requestedBudgets?: Partial<BudgetSnapshot>,
): void {
  const diff = diffInvestigations(saved, fresh, requestedBudgets);

  if (format === "json") {
    printJson(diff);
    return;
  }
  if (format === "llm") {
    // `ix context --diff --format llm` used to fall through to the prose
    // renderer below, because this path only branched on `json`. That made the
    // most common agent path the worst one: escaping the prose is what `llm`
    // exists for.
    //
    // Every line goes through `llmLine`, never a template literal. The values
    // here are the ones most likely to contain a space in the whole CLI — an
    // evidence title is a sentence, and a claim id carries the statement — and
    // `key=value` with an unquoted space is not a record a consumer can split.
    // `llmQuote` also encodes newlines, so a title cannot break the one
    // record per line invariant.
    printLlmLines(diffLlmLines(saved, fresh, diff));
    return;
  }

  renderDiffText(saved, fresh, diff);
}

/** `--diff --format llm`: one keyed record per line. */
function diffLlmLines(saved: SavedInvestigation, fresh: ContextBundle, diff: InvestigationDiff): string[] {
  const prev = saved.bundle;
  return [
    llmLine("diff", {
      investigation: saved.id,
      target: fresh.target.name,
      // How old the saved side is. `freshness_previous=current` says the
      // snapshot was fresh when it was taken, not when that was — and a
      // snapshot from five minutes ago and one from three months ago are the
      // same word. Both timestamps are on the JSON diff; only the prose
      // renderer showed them, so the llm stream was the one surface that
      // could not tell how stale the comparison's own baseline is.
      saved_at: diff.savedAt,
      generated_at: diff.generatedAt,
      freshness_previous: prev.freshness.classification,
      freshness_current: fresh.freshness.classification,
    }),
    // Which budgets governed the comparison. `scope=requested` appears
    // only when --max-* flags were passed, and carries `applied=` rather
    // than a sentence explaining itself: the precedence rule is that saved
    // budgets govern --diff, and a field an agent can test beats a note it
    // has to read. `effective` is read off the bundle that was built, so it
    // is a report and not a restatement of `saved`.
    llmLine("budgets", { scope: "saved", ...budgetFields(diff.budgets.saved) }),
    ...(diff.budgets.requested
      ? [llmLine("budgets", {
          scope: "requested",
          ...budgetFields(diff.budgets.requested),
          applied: diff.budgets.requestedApplied,
        })]
      : []),
    llmLine("budgets", { scope: "effective", ...budgetFields(diff.budgets.effective) }),
    // One record rather than eight, and the zeros are kept: "nothing was
    // added" is the answer to the question `--diff` was asked, so dropping
    // it as a default would remove the signal.
    llmLine("count", {
      added_entities: diff.added.entities.length,
      removed_entities: diff.removed.entities.length,
      added_relationships: diff.added.relationships.length,
      removed_relationships: diff.removed.relationships.length,
      added_evidence: diff.added.evidence.length,
      removed_evidence: diff.removed.evidence.length,
      added_claims: diff.added.claims.length,
      removed_claims: diff.removed.claims.length,
    }),
    // `change=` rather than a `+`/`-` prefix on the record kind: a consumer
    // routing on the kind should still match `entity` on both sides of the
    // comparison, and a fused marker means it matches neither.
    //
    // `id=` on entities is what makes the stream joinable. Relationship
    // records name their endpoints by entity id, so without it
    // `relationship src=entity-1 dst=entity-2` resolves to nothing a reader
    // has seen and an added entity cannot be matched to the edge that
    // involves it. `--format json` loses none of this, and llm carrying less
    // than the format it is meant to replace is the wrong trade.
    ...diff.added.entities.map(entityRecord("added")),
    ...diff.removed.entities.map(entityRecord("removed")),
    ...diff.added.relationships.map((r) => llmLine("relationship", { change: "added", src: llmShortId(r.src), pred: r.predicate, dst: llmShortId(r.dst) })),
    ...diff.removed.relationships.map((r) => llmLine("relationship", { change: "removed", src: llmShortId(r.src), pred: r.predicate, dst: llmShortId(r.dst) })),
    ...diff.added.evidence.map(evidenceRecord("added")),
    ...diff.removed.evidence.map(evidenceRecord("removed")),
    // `statement=` is the field that says what changed. The id is the
    // backend's (`c-8f31a2`), so `claim change=added id=c-8f31a2
    // status=active` told a reader that a claim changed and not what it
    // says. The test fixture hid it by fabricating `claim-<statement>` ids.
    ...diff.added.claims.map(claimRecord("added")),
    ...diff.removed.claims.map(claimRecord("removed")),
  ];
}

/** `--diff` as prose. */
function renderDiffText(saved: SavedInvestigation, fresh: ContextBundle, diff: InvestigationDiff): void {
  const prev = saved.bundle;
  renderSection(`Investigation diff: ${saved.id}`);
  console.log(`  freshness: ${prev.freshness.classification} -> ${fresh.freshness.classification}`);
  // Prose only: `--format llm` returned above with records of its own. The
  // llm branch here used to be this same block with the colons moved, which
  // is the one thing the format is defined not to be.
  console.log(`  budgets:`);
  console.log(`    saved     : ${formatBudgets(diff.budgets.saved)}`);
  if (diff.budgets.requested) {
    console.log(`    requested : ${formatBudgets(diff.budgets.requested, true)}`);
  } else {
    console.log(`    requested : (none)`);
  }
  console.log(`    effective : ${formatBudgets(diff.budgets.effective)}`);
  console.log(`  entities:  -${diff.removed.entities.length} +${diff.added.entities.length}`);
  console.log(`  relationships: -${diff.removed.relationships.length} +${diff.added.relationships.length}`);
  console.log(`  evidence:  -${diff.removed.evidence.length} +${diff.added.evidence.length}`);
  console.log(`  claims:    -${diff.removed.claims.length} +${diff.added.claims.length}`);
  if (diff.added.entities.length > 0) {
    renderSection("Added entities");
    for (const e of diff.added.entities) console.log(`  ${e.name} (${e.kind})`);
  }
  if (diff.removed.entities.length > 0) {
    renderSection("Removed entities");
    for (const e of diff.removed.entities) console.log(`  ${e.name} (${e.kind})`);
  }
  if (diff.added.evidence.length > 0) {
    renderSection("Added evidence");
    for (const e of diff.added.evidence) console.log(`  [${e.score}] ${e.kind} - ${e.title}`);
  }
  if (diff.removed.evidence.length > 0) {
    renderSection("Removed evidence");
    for (const e of diff.removed.evidence) console.log(`  [${e.score}] ${e.kind} - ${e.title}`);
  }
  console.log();
}

/** The fresh side of `--diff`: the saved bundle's target, rebuilt with its own budgets. */
export async function buildFreshBundle(
  target: string,
  opts: { kind?: string; path?: string; pick?: number; depth?: string; asOfRev?: number },
  budgets: BudgetSnapshot & { format?: BundleFormat },
  format: string,
  savedId?: string,
): Promise<ContextBundle | undefined> {
  const client = createClient({ query: true });
  // The saved entity itself when it still exists; a miss on its id (the
  // graph was rebuilt) falls through to its name.
  let resolved: ResolvedEntity | null = null;
  if (savedId && isRawId(savedId)) {
    const byId = await resolveFileOrEntityFull(client, savedId, { format, silentMiss: true });
    if (byId.resolved) resolved = byId.entity;
  }
  // Strict: the fresh side of --diff must be the saved bundle's entity, so a
  // name that has become ambiguous is reported, never answered with a guess
  // the diff would then compare against.
  resolved ??= await resolveFileOrReport(client, target, {
    kind: opts.kind,
    path: opts.path,
    pick: opts.pick,
    strict: true,
  }, format);
  if (!resolved) return undefined;

  const asOfRev = opts.asOfRev;
  const [facts, context, workspaceHealth] = await Promise.all([
    collectContextFacts(client, resolved),
    client.contextForNode(resolved.id, { asOfRev, depth: opts.depth }),
    checkGraphHealth(client, activeReadScope()),
  ]);

  return buildBundle({
    resolved, facts, context, provenance: facts.provenance, asOfRev, depth: opts.depth, budgets,
    // The saved bundle's own sizing format, not the diff's render format, so --diff compares like with like.
    format: budgets.format ?? "json",
    graphCompleted: hasCompletedSourceGraphBaseline(),
    graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
  });
}
