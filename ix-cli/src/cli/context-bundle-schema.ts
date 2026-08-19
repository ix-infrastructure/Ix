import { z } from "zod";

/**
 * Versioned id of the context bundle contract. Bump only on a breaking shape
 * change, never per run.
 */
export const BUNDLE_SCHEMA = "ix-context-bundle/1";

/** Versioned id of the saved-investigation envelope written by `--save`. */
export const INVESTIGATION_SCHEMA = "ix-investigation/1";

/**
 * Versioned contract for the deterministic context bundle produced by
 * `ix context` (schema `ix-context-bundle/1`).
 *
 * This is the single source of truth for the bundle's shape. The MCP server
 * uses it as the `ix_context` output schema so agents get a structured
 * contract, and the CLI validates every bundle with it on the way to disk
 * (investigation save and `--out`) and on the way back off it
 * (`loadInvestigation`), so a malformed or unexpected payload can never be
 * written as if it were a valid bundle, nor honoured when read back.
 *
 * The shapes below mirror the `ContextBundle` and `EvidenceItem` interfaces in
 * `commands/context.ts`. Fields the renderers and `--diff` dereference by name
 * — `evidence[].title`, the four `budgets`, the four `truncation` counters and
 * the `metadata` values `--diff` re-sends to the backend — are pinned to their
 * real types rather than left as open records: validation that accepts `{}`
 * where the code goes on to read `.title` or `.maxEntities` only moves the
 * failure downstream, from a named refusal to a TypeError or a NaN.
 *
 * The three backend report arrays (decisions/conflicts/intents) keep their own
 * internal shapes and stay deliberately loose here; the bundle's versioned
 * `schema` field remains the authoritative marker.
 */
export const contextBundleSchema = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  generatedAt: z.string(),
  target: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    resolutionMode: z.string(),
  }),
  entities: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string(), path: z.string().optional(), stale: z.boolean() }),
  ),
  relationships: z.array(z.object({ src: z.string(), dst: z.string(), predicate: z.string() })),
  claims: z.array(
    z
      .object({ id: z.string(), entityId: z.string(), statement: z.string(), status: z.string() })
      .catchall(z.unknown()),
  ),
  // DecisionReport/ConflictReport/IntentReport are the backend's own contracts
  // with their own shapes; they are forwarded, never dereferenced field-by-field
  // here, so they stay loose rather than duplicating those types in a second
  // place that could drift from them.
  decisions: z.array(z.record(z.string(), z.unknown())),
  conflicts: z.array(z.record(z.string(), z.unknown())),
  intents: z.array(z.record(z.string(), z.unknown())),
  provenance: z
    .object({
      sourceUri: z.string().optional(),
      sourceHash: z.string().optional(),
      extractor: z.string().optional(),
      sourceType: z.string().optional(),
      observedAt: z.string().optional(),
      introducedRev: z.number().optional(),
      historyLength: z.number(),
      stale: z.boolean(),
    })
    .catchall(z.unknown()),
  freshness: z.object({ stale: z.boolean(), classification: z.string() }),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      source: z.string(),
      title: z.string(),
      score: z.number(),
      reason: z.string(),
      refs: z.array(z.string()),
    }),
  ),
  budgets: z.object({
    maxEntities: z.number().int().positive(),
    maxRelationships: z.number().int().positive(),
    maxEvidence: z.number().int().positive(),
    maxChars: z.number().int().positive(),
  }),
  truncation: z.object({
    entitiesTruncated: z.number().int().nonnegative(),
    relationshipsTruncated: z.number().int().nonnegative(),
    evidenceTruncated: z.number().int().nonnegative(),
    charactersTruncated: z.number().int().nonnegative(),
  }),
  // `asOfRev` and `depth` are the two saved values `ix context --diff` re-sends
  // to the backend, so they are typed rather than accepted as anything.
  // Unknown keys pass through: metadata is the bundle's extension point, and
  // stripping them would silently drop data on the read-back path.
  metadata: z
    .object({
      asOfRev: z.number().optional(),
      depth: z.string().optional(),
      rankingRule: z.string(),
    })
    .catchall(z.unknown()),
});

/**
 * Contract for the on-disk saved-investigation envelope (`~/.ix/investigations`).
 *
 * `id` and `savedAt` are rendered to the terminal and copied into the emitted
 * `ix-investigation-diff/1` JSON, so they are validated here alongside the
 * bundle rather than trusted from a bare cast.
 */
export const savedInvestigationSchema = z.object({
  schema: z.literal(INVESTIGATION_SCHEMA),
  // `sanitizeId` percent-escapes anything outside this set on the way in, so a
  // stored id can only contain these characters. Pinning the same set on the
  // way out keeps control characters and ANSI escapes out of an id that
  // `renderNote`/`renderSection` write straight to the terminal.
  id: z.string().regex(/^[A-Za-z0-9._~-]+$/),
  savedAt: z.string(),
  bundle: contextBundleSchema,
});
