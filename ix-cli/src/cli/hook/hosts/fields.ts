// Copyright 2026 Ix Infrastructure Inc.

/**
 * Field readers the host adapters share. Hook payloads come from another
 * program: each reader returns undefined for a value of the wrong type rather
 * than trusting the host's spelling.
 */

/** The JSON object in `raw`, or undefined for anything that does not parse to one. An array counts, as it always has. */
export function parseObject(raw: string): Record<string, unknown> | undefined {
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return undefined; }
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? v as Record<string, unknown> : undefined;
}

/** A session or conversation id as a state key: any value but null / undefined, spelled as a string. */
export function idString(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

/** The strings in `v` when it is a list; [] for anything else. */
export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** `[path]` for a non-empty string, else []. */
export function onePath(v: unknown): string[] {
  return typeof v === "string" && v !== "" ? [v] : [];
}
