// Copyright 2026 Ix Infrastructure Inc.

export function goldFiles(patch) {
  return [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]))];
}
