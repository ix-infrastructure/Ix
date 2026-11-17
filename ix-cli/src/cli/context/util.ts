// Copyright 2026 Ix Infrastructure Inc.

// Small value helpers shared by the context modules.

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
