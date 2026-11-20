// Copyright 2026 Ix Infrastructure Inc.

/**
 * The CLI's one definition of the graph's node kinds: which kinds are types,
 * containers, callables and regions. Every command reads these sets instead of
 * keeping its own copy, so supporting a new kind is one edit here, and two
 * commands cannot disagree about what a kind is.
 *
 * Kinds are compared lower-case. Every set is typed against `GraphKind`: the
 * kinds a patch writes (`NODE_KINDS`, client/graph-schema.ts) plus the kinds
 * read here that no patch writes (`READ_ONLY_KINDS`). A kind in neither list
 * does not compile.
 *
 * This module stays pure (no client, process or output): resolve/score.ts
 * loads it. The one lookup of a file's graph node is `findFileNode` in
 * file-node.ts.
 */

import type { NodeKind } from "../client/graph-schema.js";

/**
 * Kinds the CLI's kind lists name (the sets below, and the few one-off lists
 * other commands keep) that no patch from this repo writes. The ingester
 * (`core-ingestion` `DEFINITION_KIND_MAP`) folds struct, enum, record, union,
 * impl, type alias and annotation definitions into `class`, so these never
 * occur in a graph it built; they are listed so that a graph which does carry
 * them is read the same way by every command. The region kinds are written by
 * the backend's map (`/v1/map`), not by a patch.
 */
export const READ_ONLY_KINDS = [
  // Type-like kinds the ingester folds into `class`.
  "object", "struct", "enum", "record", "annotation", "union", "impl", "type",
  // Contract kinds no extractor here writes.
  "type_alias", "sealed_trait", "abstract_class",
  // Containers the ingester writes as `module`.
  "namespace",
  // Callables under other languages' names.
  "def", "fun", "constructor",
  // The map's architectural regions.
  "system", "subsystem", "region",
  // Named by the one-off kind lists in other commands (type-walk, explain,
  // graph-health, verify); no extractor here writes them.
  "protocol", "data_class", "variable", "property", "field",
] as const;

/** A kind the CLI knows: written by a patch, or read from a graph another writer built. */
export type GraphKind = NodeKind | (typeof READ_ONLY_KINDS)[number];

/**
 * A set of kinds. Built from `GraphKind`s only, so a kind that exists nowhere
 * does not compile; asked about any string, since kinds are read off a graph.
 */
export type KindSet = ReadonlySet<GraphKind> & { has(kind: string): boolean };

/** Kinds that declare a type: a class and everything shaped like one. */
export const TYPE_KINDS: KindSet = new Set<GraphKind>([
  "class", "interface", "trait", "object", "struct", "enum", "record", "annotation",
]);

/**
 * Kinds that hold members. A bare name most likely means one of these, and
 * `impact`, `locate`, `overview` and `context` analyse one by its members
 * rather than by its own callers.
 */
export const CONTAINER_KINDS: KindSet = new Set<GraphKind>([
  "file", "module", ...TYPE_KINDS,
]);

/**
 * Definitions whose "callers" are references to a type rather than calls.
 * A file holds members but is never what a type reference names, so it is
 * not here; namespaces, impl blocks and type aliases are.
 */
export const TYPE_REFERENCE_KINDS: KindSet = new Set<GraphKind>([
  ...TYPE_KINDS, "module", "namespace", "impl", "union", "type",
]);

/**
 * Abstract types: a change to one is a change to a contract its implementers
 * and users all depend on. A concrete class is not one.
 */
export const CONTRACT_TYPE_KINDS: KindSet = new Set<GraphKind>([
  "interface", "type", "type_alias", "enum", "sealed_trait", "trait", "abstract_class",
]);

/** Kinds that can be called. */
export const CALLABLE_KINDS: KindSet = new Set<GraphKind>([
  "function", "method", "def", "fun", "constructor",
]);

/** Kinds that are real code structure, as against config, docs or decisions. */
export const STRUCTURAL_KINDS: KindSet = new Set<GraphKind>([
  ...CONTAINER_KINDS, "function", "method", "constant",
]);

/** Kinds of the map's architectural regions, linked by IN_REGION. */
export const REGION_KINDS: KindSet = new Set<GraphKind>([
  "system", "subsystem", "module", "region",
]);

/** The kind of a source file node. */
export const FILE_KINDS: KindSet = new Set<GraphKind>(["file"]);
