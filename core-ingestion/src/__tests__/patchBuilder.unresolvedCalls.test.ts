// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';
import { buildPatch, buildPatchWithResolution, UNRESOLVED_CALLS_CAP } from '../patch-builder.js';

/**
 * A call that resolves to no node writes no edge, so the names on its caller
 * are the only record `ix explain` has of it. These pin which node gets them,
 * the cap, and the count that makes a cut list visible.
 */

type Node = { type: string; kind?: string; name?: string; attrs?: Record<string, unknown> };

function nodesOf(ops: unknown[]): Node[] {
  return (ops as Node[]).filter((op) => op.type === 'UpsertNode');
}

function byName(ops: unknown[], name: string, kind?: string): Node {
  const node = nodesOf(ops).find((n) => n.name === name && (kind === undefined || n.kind === kind));
  if (!node) throw new Error(`no node ${name}`);
  return node;
}

const SOURCE = `
import { helper } from './helper';

export function first(): number {
  return helper() + Math.max(1, 2);
}

export function second(xs: number[]): number[] {
  return xs.map((x) => x + 1).filter(Boolean);
}

export function quiet(): number {
  return first();
}

setupGlobalThing();
`;

const HELPER = 'export function helper(): number { return 1; }\n';

describe('unresolved callee names', () => {
  const main = parseFile('/repo/main.ts', SOURCE)!;
  const helper = parseFile('/repo/helper.ts', HELPER)!;
  const resolved = resolveEdges([main, helper]).filter((e) => e.srcFilePath === '/repo/main.ts');
  const ops = buildPatchWithResolution(main, 'hash', 'ws', resolved).ops;

  it('go on the function that makes the calls, not on its neighbours', () => {
    // The parser records a member call by its member name.
    expect(byName(ops, 'first', 'function').attrs).toMatchObject({
      unresolved_calls: ['max'],
      unresolved_call_count: 1,
    });
    expect(byName(ops, 'second', 'function').attrs).toMatchObject({
      unresolved_calls: ['map', 'filter'],
      unresolved_call_count: 2,
    });
  });

  it('leave a function whose calls all resolved without the attrs', () => {
    const quiet = byName(ops, 'quiet', 'function').attrs!;
    expect(quiet).not.toHaveProperty('unresolved_calls');
    expect(quiet).not.toHaveProperty('unresolved_call_count');
  });

  it('keep the resolved calls as edges', () => {
    const calls = (ops as Array<{ type: string; predicate?: string }>).filter(
      (op) => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    // first -> helper (cross-file) and quiet -> first (same file).
    expect(calls).toHaveLength(2);
    expect(byName(ops, 'first', 'function').attrs!.unresolved_calls).not.toContain('helper');
  });

  it('put module-level calls on the file node', () => {
    expect(byName(ops, 'main.ts', 'file').attrs).toMatchObject({
      unresolved_calls: ['setupGlobalThing'],
      unresolved_call_count: 1,
    });
  });

  it('are recorded the same way without cross-file resolution', () => {
    const plain = buildPatch(main, 'hash', 'ws').ops;
    expect(byName(plain, 'second', 'function').attrs).toMatchObject({
      unresolved_calls: ['map', 'filter'],
      unresolved_call_count: 2,
    });
    expect(byName(plain, 'main.ts', 'file').attrs).toMatchObject({ unresolved_calls: ['setupGlobalThing'] });
  });
});

describe('the cap', () => {
  const calls = Array.from({ length: UNRESOLVED_CALLS_CAP + 7 }, (_, i) => `ext${String(i).padStart(2, '0')}();`);
  // Every name twice: the count is of distinct names, not call sites.
  const source = `export function busy(): void {\n  ${[...calls, ...calls].join('\n  ')}\n}\n`;
  const result = parseFile('/repo/busy.ts', source)!;

  it.each([
    ['buildPatchWithResolution', () => buildPatchWithResolution(result, 'hash', 'ws', []).ops],
    ['buildPatch', () => buildPatch(result, 'hash', 'ws').ops],
  ])('%s keeps the first names in source order, up to the cap, and the full distinct count', (_label, build) => {
    const attrs = byName(build(), 'busy', 'function').attrs!;
    expect(attrs.unresolved_call_count).toBe(UNRESOLVED_CALLS_CAP + 7);
    expect(attrs.unresolved_calls).toEqual(calls.slice(0, UNRESOLVED_CALLS_CAP).map((c) => c.slice(0, -3)));
  });

  it('is 20', () => {
    expect(UNRESOLVED_CALLS_CAP).toBe(20);
  });
});
