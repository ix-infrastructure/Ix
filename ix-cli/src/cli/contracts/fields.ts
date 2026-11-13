// Copyright 2026 Ix Infrastructure Inc.

/**
 * The field paths each command's `--format json` output can carry: the types
 * in this directory, published as data.
 *
 * The editor plugins read fields out of this output (jq filters in hooks,
 * property reads in TypeScript and Python). A field they read that the CLI
 * never prints is a check that always passes, and nothing here would notice.
 * `scripts/check-plugin-contract.mjs` reads this table from the build and
 * fails a plugin read of a path not listed for its command.
 *
 * Path syntax: `a.b` for a key, `a[]` for the elements of an array (a root
 * array is `[]`), and `a.*` for any key of an open record.
 *
 * Each list is checked both ways. The type checker requires it to name every
 * path of the command's type and nothing else (see {@link fieldsOf}), and
 * `__tests__/json-fields.test.ts` runs the commands and fails on a printed path
 * the list does not have. Adding a field to a type therefore means adding it
 * here, in the same change.
 *
 * Each list also carries what the command prints around or instead of its own
 * answer (contracts/envelope.ts): the failure record any command can answer
 * with (`error`, `message`, `dir`, `next`), and, for a command that takes
 * several targets, the `{ targets: [...], summary }` grouping.
 *
 * Only commands with a typed json contract are listed. A plugin read from any
 * other command is not checked yet.
 */

import type { TextResult } from "../format.js";
import type { ErrorRecordJson, MultiTargetJson } from "./envelope.js";
import type { LocateJson, LocateMissJson, LocateStrictAmbiguityJson, LocateTextMatchesJson } from "./locate.js";
import type { UnresolvedTargetJson } from "./miss.js";
import type { ReadAmbiguityJson, ReadFailureJson, ReadJson } from "./read.js";

/** Recursion budget for {@link FieldPath}: deeper than any json contract nests. */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6];

/** The paths below a value of type T, each with its leading `.` (or `[]`). */
type Below<T, D extends number> = [D] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ? "[]" | `[]${Below<E, Depth[D]>}`
    : T extends object
      ? string extends keyof T
        ? ".*"
        : { [K in keyof T & string]-?: `.${K}` | `.${K}${Below<NonNullable<T[K]>, Depth[D]>}` }[keyof T & string]
      : never;

/** Every field path a value of type T can carry, in the syntax above. */
export type FieldPath<T> = Below<T, 7> extends infer P extends string ? (P extends `.${infer Rest}` ? Rest : P) : never;

/**
 * A field list for type T that names every path of T and nothing else.
 *
 * A path T lacks fails at the element; a path of T the list leaves out fails
 * at the argument, with the missing paths in the error.
 */
function fieldsOf<T>() {
  return <const L extends readonly FieldPath<T>[]>(
    list: L & ([Exclude<FieldPath<T>, L[number]>] extends [never] ? unknown : { missing: Exclude<FieldPath<T>, L[number]> }),
  ): readonly string[] => list;
}

/** Every shape `ix locate --format json` prints for one target (contracts/locate.ts). */
type LocateOne = LocateJson | LocateMissJson | LocateStrictAmbiguityJson | LocateTextMatchesJson;

/** `ix locate a b` groups each target's answer (multi-target.ts). */
type LocateOutput = LocateOne | ErrorRecordJson | MultiTargetJson<LocateOne>;

/** Every shape `ix read --format json` prints (contracts/read.ts). */
type ReadOutput = ReadJson | ReadAmbiguityJson | ReadFailureJson | UnresolvedTargetJson | ErrorRecordJson;

/**
 * `ix text --format json`: a bare array of matches, with no paging envelope.
 * The plugins parse the root as an array, so wrapping it is a breaking change.
 * A failure is the one object it prints instead.
 */
type TextOutput = TextResult[] | ErrorRecordJson;

const CANDIDATE = ["id", "name", "kind", "path", "line", "score", "rank", "container"] as const;
const NAMED = ["id", "name", "kind", "path"] as const;
const DIAGNOSTIC = ["code", "message"] as const;
const DID_YOU_MEAN = ["name", "kind", "path", "line"] as const;

/** `prefix` plus `prefix.<key>` for each key. */
function under<P extends string, K extends string>(prefix: P, keys: readonly K[]): Array<P | `${P}.${K}`> {
  return [prefix, ...keys.map((k) => `${prefix}.${k}` as const)];
}

/** `prefix.<path>` for each path. */
function nest<P extends string, K extends string>(prefix: P, paths: readonly K[]): Array<`${P}.${K}`> {
  return paths.map((p) => `${prefix}.${p}` as const);
}

/** The failure record (envelope.ts) any command can print instead of its answer. */
const ERROR_RECORD = ["error", "message", "dir", "next"] as const;

/** The multi-target grouping (envelope.ts) around `answer`, one command's own paths. */
function multiTarget<K extends string>(answer: readonly K[]) {
  return [
    "targets", "targets[]", ...nest("targets[]", ["target", "exitCode", ...ERROR_RECORD, ...answer]),
    ...under("summary", ["total", "ok", "ambiguous", "notFound", "notMapped", "failed"]),
  ] as const;
}

const NOTICE = [
  ...under("resolutionNotices[]", ["code", "target", "message", "chosen", "candidates", "total", "truncated", "diagnostics"]),
  ...under("resolutionNotices[].chosen", NAMED),
  ...under("resolutionNotices[].candidates[]", CANDIDATE),
  ...under("resolutionNotices[].diagnostics[]", DIAGNOSTIC),
] as const;

const MISS = [
  "error", "message", "reason", "targets", "targets[]", "files", "files[]",
  "suggestions", ...under("suggestions[]", NAMED),
  "didYouMean", ...under("didYouMean[]", DID_YOU_MEAN),
  "graph", "graph.*",
] as const;

/** What `ix locate` prints for one target. */
const LOCATE_ONE = [
  ...MISS,
  ...under("resolvedTarget", NAMED),
  "resolutionMode",
  "lineRange", "lineRange.start", "lineRange.end",
  ...under("container", ["kind", "name", "id"]),
  "systemPath", ...under("systemPath[]", ["name", "kind"]),
  "hasMapData", "stale", "map_stale",
  "regions_as_of", "regions_as_of.map_rev", "regions_as_of.file_count",
  "diagnostics", ...under("diagnostics[]", DIAGNOSTIC),
  "resolutionNotices", ...NOTICE,
  "code",
  "candidates", ...under("candidates[]", CANDIDATE),
  "total", "truncated",
  "note", "target", "detail", "shown",
  "textMatches", ...under("textMatches[]", ["path", "line", "snippet"]),
] as const;

/** Field paths per command, keyed by the command's name as typed after `ix`. */
export const JSON_FIELDS: Readonly<Record<string, readonly string[]>> = {
  locate: fieldsOf<LocateOutput>()([...LOCATE_ONE, ...ERROR_RECORD, ...multiTarget(LOCATE_ONE)]),
  read: fieldsOf<ReadOutput>()([
    ...MISS, ...ERROR_RECORD,
    "targetType", "path", "lineStart", "lineEnd", "content", "symbol", "kind", "stale", "warning",
    "truncated", "totalLines", "spanEnd", "next", "resolutionMode",
    "resolutionNotices", ...NOTICE,
    "candidates", ...under("candidates[]", ["name", "kind", "path", "id", "rank", "container"]),
    "diagnostics", ...under("diagnostics[]", DIAGNOSTIC),
  ]),
  text: fieldsOf<TextOutput>()([
    ...under("[]", ["path", "line_start", "line_end", "snippet", "engine", "score", "language", "symbol_hint"]),
    ...ERROR_RECORD,
  ]),
};

/**
 * Whether `command`'s json output can carry `path`, or undefined when the
 * command has no published list (nothing is known about its fields yet).
 * An open record's `a.*` accepts every path below `a`.
 */
export function acceptsField(command: string, path: string): boolean | undefined {
  const list = Object.hasOwn(JSON_FIELDS, command) ? JSON_FIELDS[command] : undefined;
  if (!list) return undefined;
  return list.some((field) => field === path || (field.endsWith(".*") && path.startsWith(field.slice(0, -1))));
}
