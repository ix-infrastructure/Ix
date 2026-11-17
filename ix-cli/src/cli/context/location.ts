// Copyright 2026 Ix Infrastructure Inc.

// Evidence locations: `path:start-end` fields and their text form.

import type { ContextFacts } from "../explain/facts.js";

import type { EvidenceLocation } from "./types.js";

type Located = { path?: string; lineStart?: number; lineEnd?: number };

/** `path`, `lineStart` and `lineEnd`, omitting the unknown ones rather than writing `undefined`. */
export function locationFields(ref: Located): Located {
  return {
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.lineStart !== undefined ? { lineStart: ref.lineStart } : {}),
    ...(ref.lineEnd !== undefined ? { lineEnd: ref.lineEnd } : {}),
  };
}

/** The target's own `path:start-end`, or just its path when it has no range. */
export function targetLocation(facts: ContextFacts): Located | undefined {
  if (!facts.path) return undefined;
  return { path: facts.path, lineStart: facts.lineStart, lineEnd: facts.lineEnd };
}

/** An evidence `location`, or nothing when the path is unknown. */
export function locationField(ref: Located | undefined): { location?: EvidenceLocation } {
  if (!ref?.path) return {};
  return { location: { ...locationFields(ref), path: ref.path } };
}

export function lineRange(location: EvidenceLocation): string | undefined {
  const { lineStart, lineEnd } = location;
  if (lineStart === undefined) return undefined;
  return lineEnd !== undefined && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
}

export function formatLocation(location: EvidenceLocation): string {
  const lines = lineRange(location);
  return lines ? `${location.path}:${lines}` : location.path;
}
