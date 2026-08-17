import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { contextBundleSchema } from "../context-bundle-schema.js";

import { IxClient } from "../../client/api.js";
import type {
  ConflictReport,
  DecisionReport,
  GraphNode,
  IntentReport,
  StructuredContext,
} from "../../client/types.js";
import { getEndpoint } from "../config.js";
import { collectFacts, type EntityFacts } from "../explain/facts.js";
import { printLlmLines } from "../llm.js";
import { parsePickOption } from "../options.js";
import { resolveFileOrEntity } from "../resolve.js";
import { createStaleProbe } from "../stale.js";
import { renderNote, renderSection, renderWarning } from "../ui.js";

/**
 * Schema version for the deterministic bundle shape. Bump only on a breaking
 * shape change, never per run.
 */
const BUNDLE_SCHEMA = "ix-context-bundle/1";

interface ContextOptions {
  kind?: string;
  path?: string;
  pick?: number;
  depth?: string;
  asOfRev?: string;
  maxEntities?: string;
  maxRelationships?: string;
  maxEvidence?: string;
  maxChars?: string;
  out?: string;
  save?: string;
  resume?: string;
  diff?: string;
  format: string;
}

/** Stable evidence kinds, ordered by relevance tier (lower is more relevant). */
type EvidenceKind =
  | "target"
  | "structural"
  | "claim"
  | "decision"
  | "conflict"
  | "intent"
  | "relationship"
  | "provenance";

interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  title: string;
  /** Deterministic relevance score: tier plus a stable tiebreaker. */
  score: number;
  reason: string;
  refs: string[];
}

interface ContextBundle {
  schema: typeof BUNDLE_SCHEMA;
  /** The one explicitly declared time-dependent field. */
  generatedAt: string;
  target: { id: string; name: string; kind: string; resolutionMode: string };
  entities: Array<{ id: string; name: string; kind: string; path?: string; stale: boolean }>;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  claims: Array<{ id: string; entityId: string; statement: string; status: string }>;
  decisions: DecisionReport[];
  conflicts: ConflictReport[];
  intents: IntentReport[];
  provenance: {
    sourceUri?: string;
    sourceHash?: string;
    extractor?: string;
    sourceType?: string;
    observedAt?: string;
    introducedRev?: number;
    historyLength: number;
    stale: boolean;
  };
  freshness: { stale: boolean; classification: "current" | "stale" | "unverified" };
  evidence: EvidenceItem[];
  budgets: { maxEntities: number; maxRelationships: number; maxEvidence: number; maxChars: number };
  truncation: {
    entitiesTruncated: number;
    relationshipsTruncated: number;
    evidenceTruncated: number;
    charactersTruncated: number;
  };
  metadata: {
    asOfRev?: number;
    depth?: string;
    rankingRule: "deterministic-tier";
  };
}

/**
 * Build a bounded, deterministic context bundle for one target.
 *
 * This composes Ix's existing intelligence rather than re-deriving it: the
 * target is resolved through the same resolver as `ix explain`, structural
 * facts come from the same collector, and claims/conflicts/decisions/intents
 * come from the same `/v1/context` service. The only new thing here is the
 * bundling, budgeting, and deterministic ranking.
 */
export function registerContextCommand(program: Command): void {
  program
    .command("context [target]")
    .description(
      "Build a bounded, deterministic context bundle for a symbol, file, or entity (or resume/diff a saved investigation without a target)",
    )
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--depth <depth>", "Context-graph expansion depth")
    .option("--as-of-rev <n>", "Historical context as of a graph revision")
    .option("--max-entities <n>", "Maximum entities in the bundle", "50")
    .option("--max-relationships <n>", "Maximum relationships in the bundle", "100")
    .option("--max-evidence <n>", "Maximum evidence items in the bundle", "25")
    .option("--max-chars <n>", "Maximum characters of evidence output", "12000")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--out <path>", "Write the JSON bundle to this file instead of stdout")
    .option("--save <id>", "Persist the bundle as a resumable investigation state")
    .option("--resume <id>", "Render a saved investigation state without a backend")
    .option("--diff <id>", "Diff a saved investigation against a fresh build of the same target")
    .addHelpText(
      "after",
      "\nExamples:\n  ix context IngestionService\n  ix context src/main.ts --format json\n  ix context Widget --max-entities 20 --max-evidence 10\n  ix context Widget --save widget-investigation\n  ix context --resume widget-investigation\n  ix context --diff widget-investigation",
    )
    .action(async (target: string | undefined, opts: ContextOptions) => {
      if (opts.resume) {
        renderSavedInvestigation(opts.resume, opts.format);
        return;
      }
      if (opts.diff) {
        const saved = loadInvestigation(opts.diff);
        if (!saved) return;
        const fresh = await buildFreshBundle(
          target ?? saved.bundle.target.name,
          { ...opts, ...mergeDiffOptions(saved, opts) },
          saved.bundle.budgets,
        );
        if (!fresh) return;
        renderInvestigationDiff(saved, fresh, opts.format);
        return;
      }
      if (!target) {
        renderWarning("ix context requires a target unless --resume <id> or --diff <id> is given.");
        return;
      }

      const client = new IxClient(getEndpoint());

      const resolved = await resolveFileOrEntity(client, target, {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick,
      });
      if (!resolved) return;

      const asOfRev = opts.asOfRev ? parseInt(opts.asOfRev, 10) : undefined;
      const maxEntities = clampInt(opts.maxEntities, 1, 500, 50);
      const maxRelationships = clampInt(opts.maxRelationships, 1, 1000, 100);
      const maxEvidence = clampInt(opts.maxEvidence, 1, 200, 25);
      const maxChars = clampInt(opts.maxChars, 1000, 1_000_000, 12_000);

      const [facts, context, provenance] = await Promise.all([
        collectFacts(client, resolved.id, resolved.name, resolved.kind),
        client.query(resolved.name, {
          asOfRev,
          depth: opts.depth,
        }),
        client.provenance(resolved.id),
      ]);

      const bundle = buildBundle({
        resolved,
        facts,
        context,
        provenance,
        asOfRev,
        depth: opts.depth,
        budgets: { maxEntities, maxRelationships, maxEvidence, maxChars },
      });

      if (opts.save) {
        saveInvestigation(opts.save, bundle);
        renderNote(`Saved investigation "${opts.save}" (${bundle.entities.length} entities, ${bundle.relationships.length} relationships, ${bundle.evidence.length} evidence items). Resume with: ix context --resume ${opts.save}`);
        return;
      }

      if (opts.out && opts.format !== "json") {
        renderWarning("--out writes JSON; ignoring --format and forcing json.");
      }
      const out = opts.out;
      if (out) {
        const fs = await import("node:fs");
        // Validate the network-derived bundle against the versioned contract
        // before persisting it: only a bundle matching ix-context-bundle/1 is
        // written, so a malformed or unexpected backend payload can never land
        // in a caller-owned file (CodeQL js/network-data-written-to-file).
        const parsed = contextBundleSchema.safeParse(bundle);
        if (!parsed.success) {
          renderWarning(`--out "${out}" refused: the bundle does not match the ${BUNDLE_SCHEMA} schema (${parsed.error.issues.length} issue(s)).`);
          return;
        }
        // Atomic write: serialize to a private temp file in the SAME directory,
        // then rename over the target, so the write is never a check-then-write
        // race and a partial file is never visible (CodeQL js/file-system-race;
        // same pattern as the config writer in src/cli/config.ts). Renaming
        // onto an existing directory fails, which surfaces as the refusal below.
        const targetPath = resolve(out);
        const tmpPath = join(dirname(targetPath), `.${process.pid}.${Date.now().toString(36)}.tmp`);
        try {
          fs.writeFileSync(tmpPath, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
          fs.renameSync(tmpPath, targetPath);
        } catch (error) {
          try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
          const err = error as NodeJS.ErrnoException;
          if (err.code === "EISDIR" || err.code === "EPERM") {
            try {
              if (fs.statSync(targetPath).isDirectory()) {
                renderWarning(`--out "${out}" is a directory; refusing to write the bundle there.`);
                return;
              }
            } catch { /* target may not exist; fall through to rethrow */ }
          }
          throw error;
        }
        renderNote(`Wrote ${parsed.data.entities.length} entities, ${parsed.data.relationships.length} relationships, ${parsed.data.evidence.length} evidence items to ${out}`);
        return;
      }
      renderBundle(bundle, opts.format);
    });

async function buildFreshBundle(
  target: string,
  opts: { kind?: string; path?: string; pick?: number; depth?: string; asOfRev?: string },
  budgets: { maxEntities: number; maxRelationships: number; maxEvidence: number; maxChars: number },
): Promise<ContextBundle | undefined> {
  const client = new IxClient(getEndpoint());
  const resolved = await resolveFileOrEntity(client, target, {
    kind: opts.kind,
    path: opts.path,
    pick: opts.pick,
  });
  if (!resolved) return undefined;

  const asOfRev = opts.asOfRev ? parseInt(opts.asOfRev, 10) : undefined;
  const [facts, context, provenance] = await Promise.all([
    collectFacts(client, resolved.id, resolved.name, resolved.kind),
    client.query(resolved.name, { asOfRev, depth: opts.depth }),
    client.provenance(resolved.id),
  ]);

  return buildBundle({ resolved, facts, context, provenance, asOfRev, depth: opts.depth, budgets });
}
}


/** Saved investigation state lives under ~/.ix/investigations. */
function investigationDir(): string {
  // IX_HOME is the Ix home *directory*, not the investigations directory —
  // backend-status.ts, docker.ts and upgrade.ts all read it as `IX_HOME ||
  // ~/.ix` and then join their own subdirectory onto it. Putting the subdirectory
  // only in the fallback made the two branches disagree: with IX_HOME set, saved
  // investigations landed loose in the Ix home beside config.yaml, bin/ and cli/,
  // and `investigations/` was never created at all.
  return join(process.env.IX_HOME || join(homedir(), ".ix"), "investigations");
}

function investigationPath(id: string): string {
  return join(investigationDir(), `${sanitizeId(id)}.json`);
}

/**
 * Encode an investigation id into a filesystem-safe file name, injectively.
 *
 * `[A-Za-z0-9._-]` passes through unchanged; every other UTF-16 code unit —
 * including the escape marker `~` itself — is hex-encoded as `~HH`. Two
 * different logical ids can therefore never map to the same file, and a raw
 * `~` in user input cannot be confused with an encoding: `a/b`, `a?b`, and
 * `a~2Fb` all land in distinct, single-segment files under the investigation
 * directory instead of silently colliding or escaping it.
 *
 * A leading `.` is encoded too, so no id can produce a dotfile. `.` is otherwise
 * an ordinary character here, and encoding it only in first position keeps the
 * mapping injective: `.a` becomes `~2Ea`, which no other id can also produce.
 */
export function sanitizeId(id: string): string {
  let out = "";
  for (const ch of id) {
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out.startsWith(".")) out = `~2E${out.slice(1)}`;
  return out || "unnamed";
}

export function saveInvestigation(id: string, bundle: ContextBundle): void {
  const dir = investigationDir();
  mkdirSync(dir, { recursive: true });
  // Refuse to persist a bundle that does not match the versioned contract:
  // network-derived investigation state is validated before it reaches disk
  // (CodeQL js/network-data-written-to-file).
  const parsed = contextBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    renderWarning(`Refusing to save investigation "${id}": the bundle does not match the ${BUNDLE_SCHEMA} schema (${parsed.error.issues.length} issue(s)).`);
    return;
  }
  const state = {
    schema: "ix-investigation/1",
    id: sanitizeId(id),
    savedAt: new Date().toISOString(),
    bundle: parsed.data,
  };
  // Atomic write (temp + rename in the same directory), matching the config
  // writer, so a saved investigation is never partially written (CodeQL
  // js/file-system-race).
  const path = investigationPath(id);
  const tmpPath = join(dirname(path), `.${process.pid}.${Date.now().toString(36)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

interface SavedInvestigation {
  schema: string;
  id: string;
  savedAt: string;
  bundle: ContextBundle;
}

/**
 * Carry the saved investigation's revision and depth into a fresh `--diff`
 * build unless the caller explicitly overrides them, so a plain
 * `ix context --diff <id>` compares like-for-like instead of silently
 * re-basing the saved state onto current HEAD.
 */
export function mergeDiffOptions(
  saved: SavedInvestigation,
  opts: { asOfRev?: string; depth?: string },
): { asOfRev?: string; depth?: string } {
  const savedRev = saved.bundle.metadata.asOfRev;
  return {
    asOfRev: opts.asOfRev ?? (savedRev === undefined ? undefined : String(savedRev)),
    depth: opts.depth ?? saved.bundle.metadata.depth,
  };
}

export function loadInvestigation(id: string): SavedInvestigation | undefined {
  const path = investigationPath(id);
  if (!existsSync(path)) {
    renderWarning(`No saved investigation "${id}" at ${path}`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SavedInvestigation;
    if (parsed.schema !== "ix-investigation/1" || !parsed.bundle) {
      renderWarning(`Saved investigation "${id}" has an unknown schema; refusing to resume.`);
      return undefined;
    }
    // Validate the bundle coming back off disk against the same versioned
    // contract the write side already enforces (saveInvestigation and --out).
    // The two halves were asymmetric: writes were schema-checked, reads trusted
    // a bare `as` cast, so the envelope check above was the only thing standing
    // between a hand-edited, truncated or version-skewed state file and the
    // rest of the command. That gap is reachable — `--diff` re-resolves
    // `bundle.target.name` and sends it to the backend, and `--resume` renders
    // the bundle — so a file whose `schema` field is right and whose body is
    // anything at all used to be honoured.
    const bundle = contextBundleSchema.safeParse(parsed.bundle);
    if (!bundle.success) {
      renderWarning(
        `Saved investigation "${id}" does not match the ${BUNDLE_SCHEMA} schema (${bundle.error.issues.length} issue(s)); refusing to resume.`,
      );
      return undefined;
    }
    return parsed;
  } catch {
    renderWarning(`Saved investigation "${id}" is not valid JSON; refusing to resume.`);
    return undefined;
  }
}

function renderSavedInvestigation(id: string, format: string): void {
  const saved = loadInvestigation(id);
  if (!saved) return;
  if (format === "json") {
    console.log(JSON.stringify(saved, null, 2));
    return;
  }
  renderNote(`Resumed investigation "${saved.id}" saved ${saved.savedAt}`);
  renderBundle(saved.bundle, format);
}

export function diffInvestigations(saved: SavedInvestigation, fresh: ContextBundle): InvestigationDiff {
  const prev = saved.bundle;
  const addedEntities = fresh.entities.filter((e) => !prev.entities.some((p) => p.id === e.id));
  const removedEntities = prev.entities.filter((p) => !fresh.entities.some((e) => e.id === p.id));
  const addedRelationships = fresh.relationships.filter(
    (r) => !prev.relationships.some((p) => p.src === r.src && p.dst === r.dst && p.predicate === r.predicate),
  );
  const removedRelationships = prev.relationships.filter(
    (p) => !fresh.relationships.some((r) => r.src === p.src && r.dst === p.dst && r.predicate === p.predicate),
  );
  const addedEvidence = fresh.evidence.filter((e) => !prev.evidence.some((p) => p.id === e.id));
  const removedEvidence = prev.evidence.filter((p) => !fresh.evidence.some((e) => e.id === p.id));
  const addedClaims = fresh.claims.filter((c) => !prev.claims.some((p) => p.id === c.id));
  const removedClaims = prev.claims.filter((p) => !fresh.claims.some((c) => c.id === p.id));

  return {
    schema: "ix-investigation-diff/1",
    investigation: saved.id,
    savedAt: saved.savedAt,
    generatedAt: new Date().toISOString(),
    target: fresh.target,
    freshness: { previous: prev.freshness, current: fresh.freshness },
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
  added: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
  removed: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
}

function renderInvestigationDiff(saved: SavedInvestigation, fresh: ContextBundle, format: string): void {
  const prev = saved.bundle;
  const diff = diffInvestigations(saved, fresh);

  if (format === "json") {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  renderSection(`Investigation diff: ${saved.id}`);
  console.log(`  freshness: ${prev.freshness.classification} -> ${fresh.freshness.classification}`);
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

interface BuildInput {
  resolved: { id: string; name: string; kind: string; resolutionMode: string };
  facts: EntityFacts;
  context: StructuredContext;
  provenance: unknown;
  asOfRev?: number;
  depth?: string;
  budgets: { maxEntities: number; maxRelationships: number; maxEvidence: number; maxChars: number };
  /**
   * Per-entity staleness probe. Injected so buildBundle stays a pure function
   * under test; production passes nothing and gets the real baseline-backed one.
   */
  isStale?: (path: string) => boolean;
}

export function buildBundle(input: BuildInput): ContextBundle {
  const { resolved, facts, context, provenance, asOfRev, depth, budgets } = input;

  const stale = facts.stale;
  const classification = stale ? "stale" : "current";
  const prov = asRecord(provenance);

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
      path: facts.path,
      stale,
    },
  ];
  for (const node of orderedNodes(context.nodes)) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    entities.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      path: node.provenance?.sourceUri,
      stale: false, // replaced below, for the entities that survive the budget
    });
  }

  // Relationships: graph edges, ordered deterministically.
  const relationships = [...context.edges]
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.predicate, b.predicate))
    .map((edge) => ({ src: edge.src, dst: edge.dst, predicate: edge.predicate }));

  const evidence = rankEvidence({ resolved, facts, context, relationships, prov });

  const bundle: ContextBundle = {
    schema: BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    target: {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      resolutionMode: resolved.resolutionMode,
    },
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
    evidence: [],
    budgets,
    truncation: {
      entitiesTruncated: 0,
      relationshipsTruncated: 0,
      evidenceTruncated: 0,
      charactersTruncated: 0,
    },
    metadata: {
      asOfRev,
      depth,
      rankingRule: "deterministic-tier",
    },
  };

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

  const relLimit = Math.min(relationships.length, budgets.maxRelationships);
  bundle.relationships = relationships.slice(0, relLimit);
  bundle.truncation.relationshipsTruncated = relationships.length - relLimit;

  // Evidence is ordered by relevance, so keep the highest-priority prefix and
  // drop the tail when either the count or the character budget is exceeded.
  // maxChars bounds the serialized JSON size of the evidence list exactly as it
  // is emitted in the bundle (each item's JSON.stringify length, in the item's
  // deterministic key order), so the budget matches the actual representation
  // rather than an estimate from metadata lengths.
  const sizedEvidence = evidence.map((item) => ({ item, size: JSON.stringify(item).length }));
  let chars = 0;
  let kept = 0;
  for (const entry of sizedEvidence) {
    if (kept >= budgets.maxEvidence || chars + entry.size > budgets.maxChars) break;
    chars += entry.size;
    kept += 1;
  }
  bundle.evidence = evidence.slice(0, kept);
  bundle.truncation.evidenceTruncated = evidence.length - kept;
  const fullChars = sizedEvidence.reduce((sum, entry) => sum + entry.size, 0);
  bundle.truncation.charactersTruncated = Math.max(0, fullChars - chars);

  return bundle;
}

/** Deterministic evidence ranking: tier, then a stable id tiebreaker. */
function rankEvidence(input: {
  resolved: { id: string; name: string; kind: string };
  facts: EntityFacts;
  context: StructuredContext;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  prov: Record<string, unknown>;
}): EvidenceItem[] {
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
  });

  const structural: Array<{ id: string; source: string; title: string; refs: string[] }> = [];
  if (input.facts.container) {
    structural.push({
      id: `container:${input.facts.container.name}`,
      source: "facts.container",
      title: `container ${input.facts.container.name} (${input.facts.container.kind})`,
      refs: [],
    });
  }
  for (const name of input.facts.topCallers) {
    structural.push({ id: `caller:${name}`, source: "facts.callers", title: `caller ${name}`, refs: [] });
  }
  for (const name of input.facts.topDependents) {
    structural.push({
      id: `dependent:${name}`,
      source: "facts.dependents",
      title: `dependent ${name}`,
      refs: [],
    });
  }
  for (const name of input.facts.members.slice(0, 10)) {
    structural.push({ id: `member:${name}`, source: "facts.members", title: `member ${name}`, refs: [] });
  }
  structural.forEach((item, index) => {
    items.push({ ...item, kind: "structural", score: 10 + index, reason: "direct structural relationship" });
  });

  for (const scored of input.context.claims) {
    items.push({
      id: `claim:${scored.claim.id}`,
      kind: "claim",
      source: "context.claims",
      title: scored.claim.statement,
      score: 20,
      reason: `context claim (relevance ${scored.relevance}, confidence ${scored.confidence?.score ?? "n/a"})`,
      refs: [scored.claim.entityId],
    });
  }
  for (const decision of input.context.decisions) {
    items.push({
      id: `decision:${decision.title}`,
      kind: "decision",
      source: "context.decisions",
      title: decision.title,
      score: 21,
      reason: decision.rationale,
      refs: decision.entityId ? [decision.entityId] : [],
    });
  }
  for (const conflict of input.context.conflicts) {
    items.push({
      id: `conflict:${conflict.id}`,
      kind: "conflict",
      source: "context.conflicts",
      title: `${conflict.claimA} vs ${conflict.claimB}`,
      score: 22,
      reason: conflict.reason,
      refs: [],
    });
  }
  for (const intent of input.context.intents) {
    items.push({
      id: `intent:${intent.id}`,
      kind: "intent",
      source: "context.intents",
      title: intent.statement,
      score: 23,
      reason: `intent status ${intent.status}`,
      refs: [],
    });
  }

  input.relationships.slice(0, 50).forEach((edge, index) => {
    items.push({
      id: `relationship:${edge.src}:${edge.dst}:${edge.predicate}`,
      kind: "relationship",
      source: "context.edges",
      title: `${edge.src} --${edge.predicate}--> ${edge.dst}`,
      score: 30 + Math.min(index, 10),
      reason: "graph relationship from the context service",
      refs: [edge.src, edge.dst],
    });
  });

  items.push({
    id: `provenance:${target.id}`,
    kind: "provenance",
    source: "provenance + facts.history",
    title: `history length ${input.facts.historyLength}, introduced rev ${input.facts.introducedRev ?? "unknown"}`,
    score: 40,
    reason: `provenance ${input.prov.sourceType ?? "unknown"}, extractor ${input.prov.extractor ?? "unknown"}`,
    refs: [target.id],
  });

  // Stable full ordering: score, then id.
  return items.sort((a, b) => a.score - b.score || cmp(a.id, b.id));
}

function renderBundle(bundle: ContextBundle, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }
  if (format === "llm") {
    printLlmLines([
      `target=${bundle.target.name}`,
      `target_kind=${bundle.target.kind}`,
      `stale=${bundle.freshness.stale}`,
      `classification=${bundle.freshness.classification}`,
      `entities=${bundle.entities.length}`,
      `relationships=${bundle.relationships.length}`,
      `claims=${bundle.claims.length}`,
      `decisions=${bundle.decisions.length}`,
      `conflicts=${bundle.conflicts.length}`,
      `intents=${bundle.intents.length}`,
      `evidence=${bundle.evidence.length}`,
      `truncated_entities=${bundle.truncation.entitiesTruncated}`,
      `truncated_relationships=${bundle.truncation.relationshipsTruncated}`,
      `truncated_evidence=${bundle.truncation.evidenceTruncated}`,
      `truncated_chars=${bundle.truncation.charactersTruncated}`,
      ...bundle.evidence.map(
        (item) => `evidence ${item.score} ${item.kind} ${item.title.replaceAll("\n", " ")}`,
      ),
    ]);
    return;
  }

  renderSection(`Context: ${bundle.target.name}`);
  console.log(`  kind:          ${bundle.target.kind}`);
  console.log(`  classification:${bundle.freshness.classification}`);
  console.log(`  entities:      ${bundle.entities.length}`);
  console.log(`  relationships: ${bundle.relationships.length}`);
  console.log(`  claims:        ${bundle.claims.length}`);
  console.log(`  decisions:     ${bundle.decisions.length}`);
  console.log(`  conflicts:     ${bundle.conflicts.length}`);
  console.log(`  intents:       ${bundle.intents.length}`);
  if (bundle.freshness.stale) {
    renderWarning("Source has changed since last ingest. Run ix map to update.");
  }

  if (bundle.evidence.length > 0) {
    renderSection("Evidence (highest relevance first)");
    for (const item of bundle.evidence) {
      console.log(`  [${item.score}] ${item.kind} — ${item.title}`);
      console.log(`         ${item.reason}`);
    }
  }

  const trunc = bundle.truncation;
  if (trunc.entitiesTruncated + trunc.relationshipsTruncated + trunc.evidenceTruncated > 0) {
    renderNote(
      `Truncated: ${trunc.entitiesTruncated} entities, ${trunc.relationshipsTruncated} relationships, ${trunc.evidenceTruncated} evidence items. Rerun with larger --max-* budgets for more.`,
    );
  }
  console.log();
}

function orderedNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.id, b.id));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
