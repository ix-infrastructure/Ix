// Copyright 2026 Ix Infrastructure Inc.

/**
 * Every field path a parsed JSON value carries, in the syntax of
 * contracts/fields.ts: `a.b` for a key, `a[]` for an array's elements (`[]` at
 * the root). Each path is listed once, however many elements carry it.
 */
export function fieldPaths(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, prefix: string): void => {
    if (Array.isArray(node)) {
      const here = `${prefix}[]`;
      if (node.length > 0) out.add(here);
      for (const item of node) walk(item, here);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const here = prefix ? `${prefix}.${key}` : key;
        out.add(here);
        walk(child, here);
      }
    }
  };
  walk(value, "");
  return [...out];
}
