// Copyright 2026 Ix Infrastructure Inc.

/** Shared by resolution and patch construction, including chunk DEFINES edges. */
export function qualifiedKey(symbol: { name: string; container?: string; signature?: string }): string {
  return `${symbol.container ? `${symbol.container}.` : ''}${symbol.name}${symbol.signature ?? ''}`;
}
