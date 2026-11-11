// Copyright 2026 Ix Infrastructure Inc.

/**
 * The CLI's one definition of the graph's node kinds: which kinds are types,
 * containers, callables and regions. Every command reads these sets instead of
 * keeping its own copy, so supporting a new kind is one edit here, and two
 * commands cannot disagree about what a kind is.
 *
 * Kinds are compared lower-case. The ingester (`core-ingestion`
 * `DEFINITION_KIND_MAP`) folds struct, enum, record, union, impl, type alias
 * and annotation definitions into `class`, so most of the rarer kinds below
 * never occur in a graph it built; they are listed so that a graph which does
 * carry them is read the same way by every command.
 */

/** Kinds that declare a type: a class and everything shaped like one. */
export const TYPE_KINDS: ReadonlySet<string> = new Set([
  "class", "interface", "trait", "object", "struct", "enum", "record", "annotation",
]);

/**
 * Kinds that hold members. A bare name most likely means one of these, and
 * `impact`, `locate`, `overview` and `context` analyse one by its members
 * rather than by its own callers.
 */
export const CONTAINER_KINDS: ReadonlySet<string> = new Set([
  "file", "module", ...TYPE_KINDS,
]);

/**
 * Definitions whose "callers" are references to a type rather than calls.
 * A file holds members but is never what a type reference names, so it is
 * not here; namespaces, impl blocks and type aliases are.
 */
export const TYPE_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  ...TYPE_KINDS, "module", "namespace", "impl", "union", "type",
]);

/**
 * Abstract types: a change to one is a change to a contract its implementers
 * and users all depend on. A concrete class is not one.
 */
export const CONTRACT_TYPE_KINDS: ReadonlySet<string> = new Set([
  "interface", "type", "type_alias", "enum", "sealed_trait", "trait", "abstract_class",
]);

/** Kinds that can be called. */
export const CALLABLE_KINDS: ReadonlySet<string> = new Set([
  "function", "method", "def", "fun", "constructor",
]);

/** Kinds that are real code structure, as against config, docs or decisions. */
export const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  ...CONTAINER_KINDS, "function", "method", "constant",
]);

/** Kinds of the map's architectural regions, linked by IN_REGION. */
export const REGION_KINDS: ReadonlySet<string> = new Set([
  "system", "subsystem", "module", "region",
]);

/** The kind of a source file node. */
export const FILE_KINDS: ReadonlySet<string> = new Set(["file"]);
