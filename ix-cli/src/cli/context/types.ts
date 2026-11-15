// Copyright 2026 Ix Infrastructure Inc.

// The shapes `ix context` builds and renders: the bundle, its evidence rows,
// and the inputs `buildBundle` assembles them from.

import type { BUNDLE_SCHEMA } from "../context-bundle-schema.js";
import type { ConflictReport, DecisionReport, IntentReport, StructuredContext } from "../../client/types.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import type { RankedFile, StartingPoint } from "../explain/issue.js";
import type { IssueEntityRanking } from "../explain/issue-entities.js";
import type { GraphHealth } from "../graph-health.js";

import type { BudgetSnapshot, BundleFormat } from "./options.js";

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

/** Where an evidence item is defined, when the graph knows. */
export interface EvidenceLocation {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  title: string;
  /** Deterministic relevance score: tier plus a stable tiebreaker. */
  score: number;
  reason: string;
  refs: string[];
  /**
   * Without it an agent handed `member resolveWorkspaceRoot` has to search the
   * repository for the thing Ix just found -- and for a file target named
   * `config.ts`, first work out which of several `config.ts` files it was.
   */
  location?: EvidenceLocation;
  /**
   * How many of how many, for a row that samples a larger set (the "used by"
   * row). Structured so the number can be rendered as a floor where the backend
   * capped it, without parsing the title.
   */
  count?: { shown: number; total: number };
}

export interface ContextBundle {
  schema: typeof BUNDLE_SCHEMA;
  /**
   * The one explicitly declared time-dependent field. Absent from the MCP
   * structured copy so identical calls are byte-identical.
   */
  generatedAt?: string;
  target: { id: string; name: string; kind: string; resolutionMode: string; path?: string };
  /**
   * Where an issue's bundle starts, and what in the issue did not resolve.
   * Only on a bundle built with `--from-issue`; absent, not empty, otherwise.
   */
  issue?: IssueSummary;
  /** The files to read for the issue, best first. Only with `--from-issue`. */
  rankedFiles?: RankedFile[];
  entities: Array<{
    id: string;
    name: string;
    kind: string;
    path?: string;
    lineStart?: number;
    lineEnd?: number;
    stale: boolean;
    /** Issue relevance; absent on bundles built from a named target. */
    score?: number;
  }>;
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
  /**
   * `degraded` when the graph has lost its structural edges (see
   * graph-health.ts): nothing is known to have changed on disk, but the
   * bundle's members, callers and neighbours are missing, not absent.
   */
  freshness: { stale: boolean; classification: "current" | "stale" | "unverified" | "degraded" };
  /** Present only for a degraded or empty graph: what is wrong and the fix. */
  graph?: Record<string, unknown>;
  evidence: EvidenceItem[];
  /** `format` is the output the budget was sized for; absent on bundles saved before it existed (json sizing). */
  budgets: BudgetSnapshot & { format?: BundleFormat };
  truncation: {
    entitiesTruncated: number;
    relationshipsTruncated: number;
    evidenceTruncated: number;
    charactersTruncated: number;
    conflictsTruncated: number;
    /**
     * What the budget dropped, by category, largest first.
     *
     * The counts above say how much went; this says what it was. "Rerun with
     * larger --max-* budgets" was the same sentence for a file that lost 36 of
     * its own members and for a symbol that lost two claims, and it named the
     * one lever that costs the caller the most to pull.
     */
    cut?: Array<{ what: string; count: number }>;
  };
  metadata: {
    asOfRev?: number;
    depth?: string;
    rankingRule: "deterministic-tier" | "issue-bm25";
  };
}

export interface BuildInput {
  resolved: { id: string; name: string; kind: string; resolutionMode: string };
  facts: ContextFacts;
  context: StructuredContext;
  provenance: unknown;
  asOfRev?: number;
  depth?: string;
  budgets: BudgetSnapshot;
  /**
   * The output the evidence budget is charged against. Defaults to json, the
   * legacy sizing, so injected fixtures and old saved bundles keep their size.
   */
  format?: BundleFormat;
  /**
   * Per-entity staleness probe. Injected so buildBundle stays a pure function
   * under test; production passes nothing and gets the real baseline-backed one.
   */
  isStale?: (path: string) => boolean;
  /**
   * Whether the workspace has a completed source graph baseline. Injected for the same
   * reason as `isStale`: it is a filesystem question, and buildBundle stays
   * pure under test. Both production callers pass the real answer; the default
   * is the optimistic one so a bundle built from injected facts alone is not
   * silently reclassified.
   */
  graphCompleted?: boolean;
  /**
   * The graph-health verdict (graph-health.ts), workspace-wide. The target's
   * own structure is judged here from `facts`. Absent under test and when the
   * check could not run, which says nothing.
   */
  graphHealth?: GraphHealth;
  /** Set by `--from-issue`: the starting points and the ranked files. */
  issue?: IssueBundleInput;
}

/** What `--from-issue` records in the bundle. */
interface IssueSummary {
  startingPoints: StartingPoint[];
  unresolved: string[];
  /** Nothing in the issue resolved; the start is BM25's best file. */
  fallback: boolean;
}

export interface IssueBundleInput extends IssueSummary {
  rankedFiles: RankedFile[];
  /** The other starting points' related files, entered as entities. */
  extraEntities?: EntityLocation[];
  /** Lexical discoveries, behind graph context unless they match the issue. */
  discoveredEntities?: EntityLocation[];
  query?: string;
  repo?: IssueEntityRanking["repo"];
  distances?: ReadonlyMap<string, number>;
}
