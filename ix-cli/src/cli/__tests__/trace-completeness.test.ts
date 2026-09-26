// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { renderTracePathLlm, renderTraceSingleLlm, renderTraceBothLlm, searchPath } from '../commands/trace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const node = (): any => ({ id: 'n1aaaaaa', name: 'bar', kind: 'method', resolved: true, children: [] });

const n = (id: string) => ({ id, name: id.toUpperCase(), kind: 'file' });

/** Mock IxClient.expand that returns neighbours keyed by (id, direction). */
function makeClient(edges: Record<string, Record<string, Array<{ id: string; name: string; kind: string }>>>) {
  return {
    async expand(id: string, opts?: { direction?: string }) {
      const direction = opts?.direction ?? 'out';
      return { nodes: edges[id]?.[direction] ?? [], edges: [] };
    },
  };
}

const CAP_HINT = 'Node cap of 8 reached; nodes were dropped. Raise --cap, or start from a narrower target.';

// ---------------------------------------------------------------------------
// renderTraceSingleLlm — completeness flags surface instead of being discarded
// ---------------------------------------------------------------------------

describe('renderTraceSingleLlm completeness', () => {
  it('reports depth_limited with a raise-the-bound hint instead of hardcoding false', () => {
    const lines = renderTraceSingleLlm(
      { id: 'root1234', name: 'foo', kind: 'function' }, 'mixed', 'downstream', 3,
      [node()], false, 1, 1, Infinity, true,
    );
    expect(lines[0]).toContain('depth_limited=true');
    expect(lines[0]).not.toContain('truncated=true');
    expect(lines[1]).toBe(
      'diagnostic code=depth_limited message="Stopped descending at depth 3; there may be more below. Raise --depth to look further."',
    );
  });

  it('prefers the truncated code when both bounds were hit', () => {
    const lines = renderTraceSingleLlm(
      { id: 'root1234', name: 'foo', kind: 'function' }, 'mixed', 'downstream', 3,
      [node()], true, 9, 3, 8, true,
    );
    expect(lines[0]).toContain('truncated=true');
    expect(lines[0]).toContain('depth_limited=true');
    expect(lines[1]).toBe(`diagnostic code=truncated message="${CAP_HINT}"`);
  });

  it('emits neither flag nor diagnostic for an unbounded clean traversal', () => {
    const lines = renderTraceSingleLlm(
      { id: 'root1234', name: 'foo', kind: 'function' }, 'mixed', 'upstream', Infinity,
      [node()], false, 1, 1, Infinity,
    );
    expect(lines[0]).not.toContain('truncated');
    expect(lines[0]).not.toContain('depth_limited');
    expect(lines[1]).toContain('node ');
  });
});

// ---------------------------------------------------------------------------
// renderTraceBothLlm — per-direction truncation must not vanish
// ---------------------------------------------------------------------------

describe('renderTraceBothLlm completeness', () => {
  it('surfaces truncated=true plus a hint when one direction hit the node cap', () => {
    const lines = renderTraceBothLlm(
      { id: 'root1234', name: 'foo', kind: 'function' }, 'mixed', Infinity,
      { tree: [node()], nodesVisited: 9, maxDepthReached: 2, truncated: true },
      { tree: [], nodesVisited: 0, maxDepthReached: 0 },
      8,
    );
    expect(lines[0]).toContain('truncated=true');
    expect(lines[1]).toBe(`diagnostic code=truncated message="${CAP_HINT}"`);
  });

  it('emits no completeness fields for clean traversals', () => {
    const lines = renderTraceBothLlm(
      { id: 'root1234', name: 'foo', kind: 'function' }, 'mixed', Infinity,
      { tree: [node()], nodesVisited: 1, maxDepthReached: 1 },
      { tree: [], nodesVisited: 0, maxDepthReached: 0 },
    );
    expect(lines[0]).not.toContain('truncated');
    expect(lines[1]).toBe('up name=bar kind=method id=n1aaaaaa parent=root1234');
  });
});

// ---------------------------------------------------------------------------
// renderTracePathLlm — cut traversal distinguishable from genuine absence
// ---------------------------------------------------------------------------

describe('renderTracePathLlm cut visibility', () => {
  it('adds a search_cut diagnostic after no_path when the search was budget-cut', () => {
    const lines = renderTracePathLlm(
      { name: 'A', kind: 'function' }, { name: 'B', kind: 'function' }, 'mixed', [],
      'No route found from A to B within the requested search limits.',
      CAP_HINT,
    );
    expect(lines[1]).toBe('diagnostic code=no_path message="No route found from A to B within the requested search limits."');
    expect(lines[2]).toBe(`diagnostic code=search_cut message="${CAP_HINT}"`);
  });

  it('adds nothing when no cut hint is given', () => {
    const lines = renderTracePathLlm(
      { name: 'A', kind: 'function' }, { name: 'B', kind: 'function' }, 'mixed', [],
      'No route found from A to B.',
    );
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// searchPath — "no route exists" vs "budget stopped the search"
// ---------------------------------------------------------------------------

describe('searchPath cut semantics', () => {
  it('reports cut with reason node-cap when the node budget stops the search before exhausting the graph', async () => {
    // Two neighbours exist but the cap of 1 admits none of their expansions.
    const client = makeClient({ A: { out: [n('x'), n('y')] } });
    const cut = await searchPath(client as any, 'A', 'B', ['REL'], 10, 1);
    expect(cut).toEqual({ path: null, cut: true, cutReason: 'node-cap' });
  });

  it('reports cut with reason depth when nodes beyond maxDepth remain unexplored', async () => {
    const client = makeClient({ A: { out: [n('x')] }, x: { out: [n('y')] } });
    const cut = await searchPath(client as any, 'A', 'B', ['REL'], 1, 10);
    expect(cut).toEqual({ path: null, cut: true, cutReason: 'depth' });
  });

  it('reports cut=false after exhausting the graph without finding a route', async () => {
    const client = makeClient({ A: { out: [n('x'), n('y')] }, x: {}, y: {} });
    const none = await searchPath(client as any, 'A', 'B', ['REL'], 10, 10);
    expect(none).toEqual({ path: null, cut: false });
  });

  it('still finds routes that complete within the budget, and flags a cut when the same route is just out of reach', async () => {
    const client = makeClient({ A: { out: [n('x')] }, x: { out: [n('b')] } });
    const found = await searchPath(client as any, 'A', 'b', ['REL'], 10, 3);
    expect(found.cut).toBe(false);
    expect(found.path?.map((p) => p.id)).toEqual(['A', 'x', 'b']);

    // The route exists, but the budget stops one hop short — the caller must
    // be able to tell this apart from "no route exists".
    const tight = await searchPath(client as any, 'A', 'b', ['REL'], 10, 2);
    expect(tight).toEqual({ path: null, cut: true, cutReason: 'node-cap' });
  });

  it('handles cyclic graphs without false cut claims', async () => {
    const client = makeClient({ A: { out: [n('x')] }, x: { out: [n('A')] } });
    const cycle = await searchPath(client as any, 'A', 'B', ['REL'], 10, 10);
    expect(cycle).toEqual({ path: null, cut: false });
  });
});
