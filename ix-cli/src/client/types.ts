// Copyright 2026 Ix Infrastructure Inc.

import type * as GraphSchema from "./graph-schema.js";

export interface CommitResult {
  newRev: number;
  status: "Ok" | "Idempotent" | "BaseRevMismatch";
}

export interface Factor {
  value: number;
  reason: string;
}

/**
 * The factors behind a claim's confidence, as `POST /v1/context` sends them in
 * `claims[].confidence`. The combined confidence (the product of the six
 * factor values, clamped to [0, 1]; `CompactConfidence.score` in the compact
 * form) is not serialized here, so compute it from the factors.
 * `ScoredClaim.finalScore` is a different number: relevance × confidence.
 */
export interface ConfidenceBreakdown {
  baseAuthority: Factor;
  verification: Factor;
  recency: Factor;
  corroboration: Factor;
  conflictPenalty: Factor;
  intentAlignment: Factor;
}

export interface Claim {
  id: string;
  entityId: string;
  statement: string;
  status: string;
}

export interface ScoredClaim {
  claim: Claim;
  confidence: ConfidenceBreakdown;
  relevance: number;
  finalScore: number;
}

export interface CompactConfidence {
  score: number;
  authority?: number;
  factors?: Record<string, Factor>;
}

export interface CompactScoredClaim {
  entityId: string;
  field: string;
  value: unknown;
  score: number;
  confidence: CompactConfidence;
  path?: string;
  lineRange?: [number, number];
}

export interface ConflictReport {
  id: string;
  claimA: string;
  claimB: string;
  reason: string;
  recommendation: string;
}

export interface DecisionReport {
  title: string;
  rationale: string;
  entityId?: string;
  intentId?: string;
  rev: number;
}

export interface IntentReport {
  id: string;
  statement: string;
  status: string;
  confidence: number;
  parentIntent?: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  attrs: Record<string, unknown>;
  provenance: {
    sourceUri: string;
    sourceHash?: string;
    extractor: string;
    sourceType: string;
    observedAt: string;
  };
  createdRev: number;
  deletedRev?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  predicate: string;
  attrs: Record<string, unknown>;
  createdRev: number;
  deletedRev?: number;
}

export interface NodeSummary {
  id: string;
  kind: string;
  name: string;
  rev: number;
  /** A connector's citation id. Absent on repository nodes. */
  sourceUri?: string | null;
  /**
   * The repository file a code, config, doc, test or schema node was parsed
   * from. Sent by backends that have ix-infrastructure/Ix-memory#210; older
   * ones leave repository summaries without any location.
   */
  path?: string | null;
}

export interface EdgeSummary {
  id: string;
  src: string;
  dst: string;
  predicate: string;
  rev: number;
}

export interface ContextMetadata {
  query: string;
  seedEntities: string[];
  hopsExpanded: number;
  asOfRev: number;
  depth?: string;
}

export interface StructuredContext {
  claims: ScoredClaim[];
  compactClaims?: CompactScoredClaim[];
  conflicts: ConflictReport[];
  decisions: DecisionReport[];
  intents: IntentReport[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeSummaries?: NodeSummary[];
  edgeSummaries?: EdgeSummary[];
  metadata: ContextMetadata;
}

export interface SearchResult {
  nodes: GraphNode[];
}

export interface PatchSummary {
  patch_id: string;
  rev: number;
  intent?: string;
  source_uri?: string;
  timestamp?: string;
}

export interface SkipReasons {
  unchanged: number;
  emptyFile: number;
  parseError: number;
  tooLarge: number;
  minifiedLikely?: number;
}

/**
 * @deprecated The backend serves no `/v1/ingest`, and the client no longer
 * calls it. Kept only so code that imports the type through
 * `@ix/cli/client/*` still compiles.
 */
export interface IngestResult {
  filesProcessed: number;
  patchesApplied: number;
  filesSkipped?: number;
  entitiesCreated: number;
  latestRev: number;
  skipReasons?: SkipReasons;
}

export interface HealthResponse {
  status: string;
  // Backend on-disk graph format version. When a client's expected version
  // differs from this, it forces a clean re-ingest (e.g. absolute→relative
  // source_uri migration changes every node ID).
  schema_version?: number;
  // The published release the running container was built as, when it knows.
  // Absent from any backend older than Ix-memory#157, and from any image not
  // built by the release pipeline — both mean "fall back to what you tracked".
  // This is the container's own claim, not proof: it is an env var, so
  // `docker run -e` overrides it. It is the right answer to "what do you think
  // you are" and the wrong one to "what are you really", which is what
  // checkBackendImage's digest comparison is for.
  release_version?: string;
  // Whether the memory layer can reach its database (Ix-memory 1.0.33+). With
  // it unreachable the backend answers 503 and `status: "degraded"`. Absent
  // from older backends, whose health never touched the database.
  database?: "reachable" | "unreachable";
}

/** `POST /v1/degree` (Ix-memory ≥ v1.0.33): one-hop neighbour counts per node id. */
export interface DegreeResponse {
  rev: number;
  /** Count per requested id. An id the backend could not count is absent. */
  counts: Record<string, number>;
  /** True when some count stopped short of the full neighbourhood. */
  truncated: boolean;
}

export interface PatchSource {
  // uri is the provenance source URI. In the client-agnostic backend design it
  // is a workspace-relative path (POSIX separators), not an absolute host path.
  // The backend treats this as an opaque string key for joins/tombstones.
  uri: string;
  sourceHash?: string;
  extractor: string;
  sourceType: string;
  // workspaceId uniquely identifies the workspace whose files produced this
  // patch. Derived client-side as SHA-256 of the workspace root's absolute
  // path. Backend stores it as an opaque attribute for future multi-workspace
  // disambiguation; it does not interpret the value.
  workspaceId?: string;
}

// The op shapes are defined once, in graph-schema.ts (a copy of
// core-ingestion/src/schema.ts). Each is named here so docs/api/openapi.yaml's
// schemas have a counterpart in this file (scripts/check-api-parity.mjs).
export type NodeKind = GraphSchema.NodeKind;
export type EdgePredicate = GraphSchema.EdgePredicate;
export type PatchOp = GraphSchema.PatchOp;
export type UpsertNodeOp = GraphSchema.UpsertNodeOp;
export type UpsertEdgeOp = GraphSchema.UpsertEdgeOp;
export type DeleteNodeOp = GraphSchema.DeleteNodeOp;
export type DeleteEdgeOp = GraphSchema.DeleteEdgeOp;
export type AssertClaimOp = GraphSchema.AssertClaimOp;
export type RetractClaimOp = GraphSchema.RetractClaimOp;

export interface GraphPatchPayload {
  patchId: string;
  actor: string;
  timestamp: string;
  source: PatchSource;
  baseRev: number;
  ops: PatchOp[];
  replaces: string[];
  intent?: string;
}

export interface PatchCommitResult {
  status: string;
  rev: number;
}

export interface CapabilitiesResponse {
  // Optional because older backends pre-date this field — clients should
  // treat absence as "unknown" rather than "false" to stay compatible with
  // older deployments.
  proFeaturesEnabled?: boolean;
  /** The local-auth contract the backend speaks ("bearer-v1"); absent before the guard. */
  local_auth?: string;
  /** Whether the backend requires the bearer token (IX_LOCAL_TOKEN is set on it). */
  local_auth_enforcing?: boolean;
}

// ── Notes and sessions (/v1/note*, /v1/notes, /v1/session*, /v1/sessions) ──
//
// The memory layer's note/session surface. The backend serves it in the OSS
// image as well as in Ix Pro's cloud, and `ix note` / `ix session` print these
// shapes verbatim under --json, so they are a contract with callers that parse
// that output (Peer2Peer's ext-ix reads `ix note show <id> --json`).

/** The note tags the CLI accepts for `--tag`. */
export type NoteTag = "finding" | "decision" | "reminder" | "note";

/** The body of `POST /v1/note` and `POST /v1/note/{id}/supersede`. */
export interface CreateNoteRequest {
  text: string;
  tag?: string;
  actor?: string;
  nodeIds?: string[];
  /** A session name or id; the backend resolves a name to its id. */
  sessionId?: string;
}

/** A note as `POST /v1/note` and `GET /v1/session/{nameOrId}/notes` return it. */
export interface Note {
  id: string;
  text: string;
  tag: string;
  actor?: string | null;
  nodeIds: string[];
  at: string;
  stale: boolean;
  staleReason?: string | null;
}

/** The richer note `GET /v1/note/{id}` and `GET /v1/notes` return. */
export interface NoteSearchResult extends Note {
  sessionId?: string | null;
  sessionName?: string | null;
  lifecycleStatus?: string | null;
  supersedes?: string[] | null;
  supersededBy?: string[] | null;
}

/** Query of `GET /v1/notes`. */
export interface ListNotesParams {
  q?: string;
  tag?: string;
  actor?: string;
  since?: string;
  limit?: number;
  includeSuperseded?: boolean;
}

/** `POST /v1/note/{id}/supersede`. */
export interface SupersedeNoteResult {
  status: string;
  oldNoteId: string;
  newNote: Note;
}

/** `POST /v1/note/{id}/retract`. */
export interface RetractNoteResult {
  status: string;
  noteId: string;
}

/** A session as every `/v1/session*` read and write returns it. */
export interface SessionInfo {
  sessionId: string;
  name: string;
  purpose: string;
  actor: string;
  actors: string[];
  ttlHours: number;
  createdAt: string;
  lastLoadedAt: string | null;
}

/** The body of `POST /v1/session`. */
export interface CreateSessionRequest {
  purpose: string;
  actor: string;
  ttlHours?: number;
  /** Generated by the backend when absent. */
  name?: string;
}

/** `POST /v1/session/{nameOrId}/pin`. */
export interface PinSessionResult {
  status: string;
  count: number;
}

/** `DELETE /v1/session/{nameOrId}`. */
export interface DeleteSessionResult {
  status: string;
}
