// Copyright 2026 Ix Infrastructure Inc.

import type { LlmFields, LlmValue } from "./llm.js";

/**
 * `--quiet` and `--fields`: what the caller wants off the answer.
 *
 * Both are properties of a run rather than of a payload, so the renderers read
 * them from here instead of every signature growing two parameters it only
 * forwards. Recorded once by the root `preAction` hook, the same way `--pretty`
 * is.
 */
let quiet = false;
let fields: string[] | undefined;

export function setOutputShape(shape: { quiet?: boolean; fields?: string }): void {
  quiet = shape.quiet === true;
  fields = parseFields(shape.fields);
}

/**
 * True when the caller asked for the answer without the scaffolding.
 *
 * "Scaffolding" is a narrow word here: section titles, `Resolved:` headers and
 * advisory hints. It is NOT the truncation records or the error records — a
 * caller asking for less output is not asking to be misled about what was cut,
 * and `--quiet` that hid `shown=50 total=212` would undo the one thing those
 * records exist for.
 */
export function isQuiet(): boolean {
  return quiet;
}

/** The fields the caller asked for, or undefined for all of them. */
export function requestedFields(): string[] | undefined {
  return fields;
}

/** `name,path,lines` -> `["name", "path", "lines"]`, or undefined. */
export function parseFields(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const names = raw.split(",").map((f) => f.trim()).filter((f) => f !== "");
  return names.length > 0 ? names : undefined;
}

/**
 * Keep only the requested fields of one row, in the order the caller named
 * them.
 *
 * The caller's order, not the renderer's: `--fields path,name` is a request for
 * a column layout, and answering it in the renderer's order silently ignores
 * half of what was asked. A name that no row carries is dropped rather than
 * emitted empty — `llmField` already omits an absent value, so inventing a
 * `lines=` for a file would be the one shape this cannot produce honestly.
 *
 * Applies to rows, never to a header: `shown=`, `total=` and `truncated=` are
 * the answer's own bookkeeping, and a projection that removed them would make
 * a partial list look complete.
 */
export function projectRow(pairs: Array<[string, LlmValue]>): Array<[string, LlmValue]> {
  const wanted = fields;
  if (!wanted) return pairs;
  const byKey = new Map(pairs);
  const out: Array<[string, LlmValue]> = [];
  for (const key of wanted) {
    if (byKey.has(key)) out.push([key, byKey.get(key) as LlmValue]);
  }
  return out;
}

/** The same, for a renderer that builds its fields as an object. */
export function projectFields(fieldsIn: LlmFields): LlmFields {
  return Array.isArray(fieldsIn)
    ? projectRow(fieldsIn)
    : projectRow(Object.entries(fieldsIn));
}
