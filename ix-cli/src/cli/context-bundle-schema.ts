// Copyright 2026 Ix Infrastructure Inc.

import { createRequire } from "node:module";
import type * as Zod from "zod";

/**
 * Versioned id of the context bundle contract. Bump only on a breaking shape
 * change, never per run.
 */
export const BUNDLE_SCHEMA = "ix-context-bundle/1";

/** Versioned id of the saved-investigation envelope written by `--save`. */
export const INVESTIGATION_SCHEMA = "ix-investigation/1";

/**
 * zod costs ~40 ms of module loading, on every command, and only four paths
 * of `ix context` ever validate (`--out`, `--save`, `--resume`/`--diff`,
 * `--list`). So the schemas are built on first use, from a synchronous require
 * (zod ships CommonJS too) because two of those paths are synchronous.
 */
const requireZod = createRequire(import.meta.url);

function buildSchemas(z: typeof Zod.z) {
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
   * — `evidence[].title`, the `budgets`, the four `truncation` counters and
   * the `metadata` values `--diff` re-sends to the backend — are pinned to their
   * real types rather than left as open records: validation that accepts `{}`
   * where the code goes on to read `.title` or `.maxEntities` only moves the
   * failure downstream, from a named refusal to a TypeError or a NaN.
   *
   * The three backend report arrays (decisions/conflicts/intents) keep their own
   * internal shapes and stay deliberately loose here; the bundle's versioned
   * `schema` field remains the authoritative marker.
   */
  const contextBundleSchema = z.object({
    schema: z.literal(BUNDLE_SCHEMA),
    generatedAt: z.string(),
    target: z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      resolutionMode: z.string(),
      path: z.string().optional(),
    }),
    // Both optional, and only on a bundle built with `--from-issue`: every
    // bundle saved before them, and every bundle built from a named target,
    // still validates. Declared rather than left out, because zod strips an
    // undeclared key on the way to disk and on the way back.
    issue: z
      .object({
        startingPoints: z.array(
          z.object({
            token: z.string(),
            id: z.string().optional(),
            name: z.string(),
            kind: z.string(),
            path: z.string(),
            lineStart: z.number().int().positive().optional(),
            lineEnd: z.number().int().positive().optional(),
            via: z.enum(["path in issue", "identifier in issue", "bm25 fallback"]),
          }),
        ),
        unresolved: z.array(z.string()),
        fallback: z.boolean(),
      })
      .optional(),
    rankedFiles: z
      .array(z.object({ path: z.string(), score: z.number(), reason: z.string() }))
      .optional(),
    entities: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        path: z.string().optional(),
        lineStart: z.number().int().positive().optional(),
        lineEnd: z.number().int().positive().optional(),
        stale: z.boolean(),
      }),
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
    // Only when the graph the bundle was drawn from is degraded or empty (see
    // graph-health.ts). Optional and additive, like `issue`; declared so zod
    // does not strip it on the way to disk.
    graph: z
      .object({
        status: z.string(),
        reason: z.string().optional(),
        message: z.string().optional(),
        fix: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    evidence: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        source: z.string(),
        title: z.string(),
        score: z.number(),
        reason: z.string(),
        refs: z.array(z.string()),
        // Optional and additive: bundles saved before it existed still parse.
        // Listed rather than left to `catchall`, because an unlisted key is
        // stripped on the way to disk and on the way back.
        location: z
          .object({
            path: z.string(),
            lineStart: z.number().int().positive().optional(),
            lineEnd: z.number().int().positive().optional(),
          })
          .optional(),
      }),
    ),
    budgets: z.object({
      maxEntities: z.number().int().positive(),
      maxRelationships: z.number().int().positive(),
      maxEvidence: z.number().int().positive(),
      // Optional, and only this one. A bundle built before `--max-tokens`
      // existed carries the other four and nothing else, and zod strips keys it
      // does not declare — so leaving it out here would not have been "tolerant
      // of old files", it would have silently dropped the field from every new
      // one on its way to disk. Required would refuse to load those old files
      // instead, which is a worse answer than reporting `tokens=not-given`.
      maxTokens: z.number().int().positive().optional(),
      maxChars: z.number().int().positive(),
      // Optional and declared: the output the budget was sized for. Undeclared
      // it would be stripped on save; required it would refuse older files.
      format: z.enum(["llm", "json", "text"]).optional(),
    }),
    truncation: z.object({
      // Optional for the same reason `budgets.maxTokens` is: a bundle saved
      // before this field existed carries the counters and nothing else, and an
      // undeclared key would be stripped from every new one on its way to disk.
      cut: z.array(z.object({ what: z.string(), count: z.number().int().positive() })).optional(),
      entitiesTruncated: z.number().int().nonnegative(),
      relationshipsTruncated: z.number().int().nonnegative(),
      evidenceTruncated: z.number().int().nonnegative(),
      charactersTruncated: z.number().int().nonnegative(),
      // Optional on the way in, always written on the way out: a bundle saved
      // before the conflict cap existed has no such counter, and refusing to
      // read it back would break `--diff` against every investigation on disk.
      conflictsTruncated: z.number().int().nonnegative().optional(),
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
  const savedInvestigationSchema = z.object({
    schema: z.literal(INVESTIGATION_SCHEMA),
    // `sanitizeId` percent-escapes anything outside this set on the way in, so a
    // stored id can only contain these characters. Pinning the same set on the
    // way out keeps control characters and ANSI escapes out of an id that
    // `renderNote`/`renderSection` write straight to the terminal.
    id: z.string().regex(/^[A-Za-z0-9._~-]+$/),
    savedAt: z.string(),
    bundle: contextBundleSchema,
  });

  return { contextBundleSchema, savedInvestigationSchema };
}

let built: ReturnType<typeof buildSchemas> | undefined;
function schemas(): ReturnType<typeof buildSchemas> {
  return (built ??= buildSchemas((requireZod("zod") as typeof Zod).z));
}

type BundleSchema = ReturnType<typeof buildSchemas>["contextBundleSchema"];
type InvestigationSchema = ReturnType<typeof buildSchemas>["savedInvestigationSchema"];

/** The bundle contract (see `buildSchemas`); zod is loaded on the first parse. */
export const contextBundleSchema = {
  parse: (value: unknown): Zod.infer<BundleSchema> => schemas().contextBundleSchema.parse(value),
  safeParse: (value: unknown): ReturnType<BundleSchema["safeParse"]> => schemas().contextBundleSchema.safeParse(value),
};

/** The saved-investigation contract (see `buildSchemas`); zod is loaded on the first parse. */
export const savedInvestigationSchema = {
  parse: (value: unknown): Zod.infer<InvestigationSchema> => schemas().savedInvestigationSchema.parse(value),
  safeParse: (value: unknown): ReturnType<InvestigationSchema["safeParse"]> =>
    schemas().savedInvestigationSchema.safeParse(value),
};
