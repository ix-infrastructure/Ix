// Copyright 2026 Ix Infrastructure Inc.

/**
 * The graph patch schema: every node kind and edge predicate a patch from this
 * repo can write, the shape of each patch op, and the attrs each node family
 * carries. `docs/api/openapi.yaml` (`PatchOp`) documents the same shapes.
 *
 * Two copies, one definition. This file is canonical; the CLI cannot import it
 * across packages (its `rootDir` is `ix-cli/src`), so
 * `ix-cli/src/client/graph-schema.ts` is a byte-identical copy, and
 * `ix-cli/src/client/__tests__/graph-schema.test.ts` fails when the two differ.
 * Edit this file, then copy it over the other.
 *
 * This module has no imports, so the copy compiles on its own.
 *
 * The wire format is unchanged by these types: they describe what was already
 * sent. Note that symbol nodes carry `line_start` / `line_end` while chunk nodes
 * carry `start_line` / `end_line`; unifying them would change stored graphs.
 */

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

/**
 * Every node kind a patch from this repo writes. Most come from the parser
 * (`ParsedEntity.kind` in core-ingestion), which folds struct, enum, record,
 * union, impl, type alias, annotation and the like into `class`
 * (`DEFINITION_KIND_MAP`).
 *
 * @public Listed for readers and contributors; the CLI types its kind sets against it.
 */
export const NODE_KINDS = [
  // A source file; one per patch.
  'file',
  // Code symbols.
  'module',
  'class',
  'interface',
  'trait',
  'function',
  'method',
  'constant',
  'macro',
  // SQL.
  'table',
  'view',
  // LaTeX \label.
  'label',
  // Config files: a Dockerfile build stage, and a key or instruction.
  'config',
  'config_entry',
  // Docs: Markdown front matter and headings, LaTeX sections and environments.
  // A Markdown section chunk is also written as a `section` node.
  'frontmatter',
  'heading',
  'section',
  'environment',
  // A retrieval span of a file, written by the patch builder.
  'chunk',
  // `ix ingest --github`: an issue (intent), a PR (decision), a comment or commit (doc).
  'intent',
  'doc',
  'decision',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

// ---------------------------------------------------------------------------
// Edge predicates
// ---------------------------------------------------------------------------

/**
 * Every edge predicate a patch from this repo writes.
 *
 * @public Listed for readers and contributors.
 */
export const EDGE_PREDICATES = [
  // Parent to child: file to symbol, class to member, table to key.
  'CONTAINS',
  'CALLS',
  'IMPORTS',
  // Inheritance and implementation.
  'EXTENDS',
  // A use of a type or name that is not a call.
  'REFERENCES',
  // File to chunk.
  'CONTAINS_CHUNK',
  // Chunk to the symbol it spans.
  'DEFINES',
  // Chunk to the next top-level chunk in source order.
  'NEXT',
] as const;

export type EdgePredicate = (typeof EDGE_PREDICATES)[number];

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/** Attrs are an open map on the wire; the families below say what each writer puts in it. */
export type Attrs = Record<string, unknown>;

/**
 * Calls that wrote no edge, on the node that makes them (or on the file).
 * Present only when there is at least one.
 */
export type UnresolvedCallAttrs = {
  /** Distinct callee names as written, in source order, at most `UNRESOLVED_CALLS_CAP`. */
  unresolved_calls?: string[];
  /** How many distinct names there were, so a cut list shows as one. */
  unresolved_call_count?: number;
};

/**
 * A node the parser found in a file other than the file itself. Symbols,
 * config entries (a config key, a Dockerfile instruction, a SQL index),
 * headings and every other parsed kind share this shape.
 */
export type SymbolNodeAttrs = UnresolvedCallAttrs & {
  line_start: number;
  line_end: number;
  language: string;
  /** The file's role (production, test, fixture, ...). */
  role: string;
  role_source: 'inherited_from_file';
};

/** A `file` node. */
export type FileNodeAttrs = UnresolvedCallAttrs & {
  line_start: number;
  line_end: number;
  language: string;
  role: string;
  role_confidence: number;
  role_signals: string[];
  /** Set when tree-sitter reported a syntax error in the file. */
  parse_errors?: true;
};

/** A `chunk` node, or a `section` node written for a Markdown section chunk. */
export type ChunkNodeAttrs = {
  /** Workspace-relative path of the file the chunk is in. */
  file_uri: string;
  language: string;
  /** What the span is: function, class, file_body, build_stage, create_table, ... */
  chunk_kind: string;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  /** SHA-256 of the chunk's text. */
  content_hash: string;
  /** The extractor that wrote it. */
  parser_version: string;
};

/** A call target in an outside package (R `pkg::fn`), minted as a `function` node. */
export type ExternalNodeAttrs = {
  package: string;
  external: true;
  language: string;
};

/** Attrs of an edge `resolveEdges` tied to another file. Other edges have none. */
export type ResolvedEdgeAttrs = {
  confidence?: number;
  /** How it was resolved: type, binding, import, transitive, qualifier or global. */
  tier?: string;
};

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** Create or replace a node. */
export interface UpsertNodeOp {
  type: 'UpsertNode';
  id: string;
  kind: NodeKind;
  name: string;
  attrs: Attrs;
}

/** Create or replace an edge. */
export interface UpsertEdgeOp {
  type: 'UpsertEdge';
  id: string;
  src: string;
  dst: string;
  predicate: EdgePredicate;
  attrs: Attrs;
}

/** Retire a node by id. */
export interface DeleteNodeOp {
  type: 'DeleteNode';
  id: string;
}

/** Retire an edge by id. */
export interface DeleteEdgeOp {
  type: 'DeleteEdge';
  id: string;
}

/** Assert a fact about a node, for the confidence and conflict engine. */
export interface AssertClaimOp {
  type: 'AssertClaim';
  entityId: string;
  /** `<predicate in lower case>:<target name>`, e.g. `calls:render`. */
  field: string;
  value: unknown;
  /** Null lets the backend score it. */
  confidence: number | null;
}

/**
 * Withdraw a claim. No writer in this repo sends one, so only the
 * discriminator is fixed here; the other fields are the backend's.
 */
export interface RetractClaimOp {
  type: 'RetractClaim';
  [field: string]: unknown;
}

/** One op in a graph patch, told apart by `type`. */
export type PatchOp =
  | UpsertNodeOp
  | UpsertEdgeOp
  | DeleteNodeOp
  | DeleteEdgeOp
  | AssertClaimOp
  | RetractClaimOp;
