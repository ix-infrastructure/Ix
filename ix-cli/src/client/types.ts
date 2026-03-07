export interface CommitResult {
  newRev: number;
  status: "Ok" | "Idempotent" | "BaseRevMismatch";
}

export interface Factor {
  value: number;
  reason: string;
}

export interface ConfidenceBreakdown {
  baseAuthority: Factor;
  verification: Factor;
  recency: Factor;
  corroboration: Factor;
  conflictPenalty: Factor;
  intentAlignment: Factor;
  score: number;
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
}

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
}
