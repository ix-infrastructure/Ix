// Copyright 2026 Ix Infrastructure Inc.

// The `entity`, `evidence` and `claim` llm records, shared by the bundle
// renderer and `--diff`.

import { llmLine, llmShortId } from "../llm.js";

import { lineRange } from "./location.js";
import type { EvidenceItem, ContextBundle } from "./types.js";

/** Which side of a comparison a record is on, or neither for a plain bundle. */
type RecordChange = "added" | "removed" | undefined;

/**
 * The `entity`, `evidence` and `claim` records, built in one place.
 *
 * `ix context <target> --format llm` and `ix context --diff <id> --format llm`
 * are the same command and emitted two different grammars for the same record
 * kind: the bundle renderer built `evidence 30 relationship <title>` from a
 * template literal, positional and unquoted, so a title with a space in it —
 * which is every title — split into tokens no consumer could reassemble. These
 * builders are the keyed form, and `llmQuote` handles the spaces and newlines.
 *
 * `change` is dropped when absent (`llmField` drops nullish), so the plain
 * bundle emits the same record without it.
 */
export function entityRecord(change: RecordChange) {
  return (e: ContextBundle["entities"][number]): string =>
    llmLine("entity", {
      change,
      // Relationship records name their endpoints by entity id, so this is
      // what lets a reader resolve `src=`/`dst=` to something it has seen.
      // Shortened on both sides of that reference, so it still resolves.
      id: llmShortId(e.id),
      kind: e.kind,
      name: e.name,
      path: e.path,
      // Only when true: `stale=false` on every entity is noise, and `llmField`
      // renders a boolean rather than dropping it.
      stale: e.stale || undefined,
    });
}

export function evidenceRecord(change: RecordChange) {
  return (e: EvidenceItem): string =>
    llmLine("evidence", {
      change,
      score: e.score,
      kind: e.kind,
      title: e.title,
      path: e.location?.path,
      lines: e.location ? lineRange(e.location) : undefined,
    });
}

export function claimRecord(change: RecordChange) {
  return (c: ContextBundle["claims"][number]): string =>
    llmLine("claim", {
      change,
      id: llmShortId(c.id),
      entity: llmShortId(c.entityId),
      status: c.status,
      statement: c.statement,
    });
}
