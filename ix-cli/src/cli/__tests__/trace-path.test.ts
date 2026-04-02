import { describe, expect, it } from 'vitest';

import { findPath, pickTraceTarget } from '../commands/trace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock IxClient.expand that returns neighbours keyed by (id, direction). */
function makeClient(edges: Record<string, Record<string, Array<{ id: string; name: string; kind: string }>>>) {
  return {
    async expand(id: string, opts?: { direction?: string }) {
      const direction = opts?.direction ?? 'out';
      return { nodes: edges[id]?.[direction] ?? [], edges: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Existing: inbound-edge traversal
// ---------------------------------------------------------------------------

describe('trace path search', () => {
  it('finds a route through inbound edges when the connection is reversed from the starting node', async () => {
    const client = {
      async expand(id: string, opts?: { direction?: string }) {
        const direction = opts?.direction ?? 'both';
        if (id === 'pcm-file' && direction === 'out') {
          return { nodes: [{ id: 'graph-utils-file', name: 'GraphUtils.h', kind: 'file' }], edges: [] };
        }
        if (id === 'graph-utils-file' && direction === 'in') {
          return { nodes: [{ id: 'pcm-file', name: 'Pcm.h', kind: 'file' }], edges: [] };
        }
        return { nodes: [], edges: [] };
      },
    };

    const path = await findPath(client as any, 'graph-utils-file', 'pcm-file', ['IMPORTS'], 4);

    expect(path).toEqual([
      { id: 'graph-utils-file', name: '', kind: '' },
      { id: 'pcm-file', name: 'Pcm.h', kind: 'file' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1-hop: map.ts → ingest.ts
//
// map.ts calls ingestFiles imported from ingest.ts — a direct IMPORTS edge.
// Manually verified: ix-cli/src/cli/commands/map.ts line 7
//   import { ingestFiles } from "./ingest.js";
// ---------------------------------------------------------------------------

describe('one-hop import path', () => {
  it('map.ts → ingest.ts: direct IMPORTS edge', async () => {
    const client = makeClient({
      'map-ts': {
        out: [{ id: 'ingest-ts', name: 'ingest.ts', kind: 'file' }],
        in:  [],
      },
      'ingest-ts': { out: [], in: [] },
    });

    const path = await findPath(client as any, 'map-ts', 'ingest-ts', ['IMPORTS'], 4);

    expect(path).not.toBeNull();
    expect(path).toHaveLength(2);
    expect(path![0]).toEqual({ id: 'map-ts', name: '', kind: '' });
    expect(path![1]).toMatchObject({ id: 'ingest-ts', name: 'ingest.ts', kind: 'file' });
  });
});

// ---------------------------------------------------------------------------
// 2-hop: oss.ts → trace.ts → depends.ts
//
// Manually verified import chain:
//   ix-cli/src/cli/register/oss.ts:
//     import { registerTraceCommand } from "../commands/trace.js";
//   ix-cli/src/cli/commands/trace.ts:
//     import { buildDependencyTree } from "./depends.js";
// ---------------------------------------------------------------------------

describe('two-hop import path', () => {
  it('oss.ts → trace.ts → depends.ts: two-hop IMPORTS chain', async () => {
    const client = makeClient({
      'oss-ts': {
        out: [{ id: 'trace-ts', name: 'trace.ts', kind: 'file' }],
        in:  [],
      },
      'trace-ts': {
        out: [{ id: 'depends-ts', name: 'depends.ts', kind: 'file' }],
        in:  [{ id: 'oss-ts',    name: 'oss.ts',     kind: 'file' }],
      },
      'depends-ts': { out: [], in: [] },
    });

    const path = await findPath(client as any, 'oss-ts', 'depends-ts', ['IMPORTS'], 5);

    expect(path).not.toBeNull();
    expect(path).toHaveLength(3);
    expect(path!.map(n => n.id)).toEqual(['oss-ts', 'trace-ts', 'depends-ts']);
    expect(path![1]).toMatchObject({ id: 'trace-ts', name: 'trace.ts', kind: 'file' });
    expect(path![2]).toMatchObject({ id: 'depends-ts', name: 'depends.ts', kind: 'file' });
  });
});

// ---------------------------------------------------------------------------
// No path: disconnected files return null
//
// parse-pool.ts has no import relationship with api.ts — they are independent
// modules. A search between them should exhaust the graph and return null.
// ---------------------------------------------------------------------------

describe('no path between disconnected files', () => {
  it('parse-pool.ts ↔ api.ts: returns null when no route exists', async () => {
    const client = makeClient({
      'parse-pool-ts': {
        out: [{ id: 'node-worker-threads', name: 'worker_threads', kind: 'module' }],
        in:  [{ id: 'ingest-ts',           name: 'ingest.ts',      kind: 'file' }],
      },
      'node-worker-threads': { out: [], in: [] },
      'ingest-ts':           { out: [], in: [] },
      'api-ts':              { out: [], in: [] },
    });

    const path = await findPath(client as any, 'parse-pool-ts', 'api-ts', ['IMPORTS'], 6);

    expect(path).toBeNull();
  });
});

describe('trace target selection', () => {
  it('prefers the exact-name config entry that has traversable downstream edges', async () => {
    const client = {
      async search() {
        return [
          { id: 'orphan-name', kind: 'config_entry', name: 'name', provenance: { source_uri: '/repo/countries-unescaped.json' } },
          { id: 'nested-name', kind: 'config_entry', name: 'name', provenance: { source_uri: '/repo/countries.json' } },
        ];
      },
      async expand(id: string, opts?: { direction?: string }) {
        if (id === 'orphan-name' && opts?.direction === 'out') {
          return { nodes: [], edges: [] };
        }
        if (id === 'nested-name' && opts?.direction === 'out') {
          return {
            nodes: [
              { id: 'common', kind: 'config_entry', name: 'common' },
              { id: 'official', kind: 'config_entry', name: 'official' },
            ],
            edges: [],
          };
        }
        return { nodes: [], edges: [] };
      },
    };

    const target = await pickTraceTarget(
      client as any,
      'name',
      { id: 'orphan-name', kind: 'config_entry', name: 'name', path: '/repo/countries-unescaped.json', resolutionMode: 'exact' },
      { direction: 'downstream', predicates: ['CONTAINS'] },
    );

    expect(target.id).toBe('nested-name');
    expect(target.path).toBe('/repo/countries.json');
  });

  it('uses trace-ranked candidates when --pick is provided for duplicate config keys', async () => {
    const client = {
      async search() {
        return [
          { id: 'orphan-name', kind: 'config_entry', name: 'name', provenance: { source_uri: '/repo/countries-unescaped.json' } },
          { id: 'nested-name', kind: 'config_entry', name: 'name', provenance: { source_uri: '/repo/countries.json' } },
          { id: 'deep-name', kind: 'config_entry', name: 'name', provenance: { source_uri: '/repo/alt.json' } },
        ];
      },
      async expand(id: string, opts?: { direction?: string }) {
        if (opts?.direction !== 'out') return { nodes: [], edges: [] };
        if (id === 'nested-name') {
          return { nodes: [{ id: 'common', kind: 'config_entry', name: 'common' }], edges: [] };
        }
        if (id === 'deep-name') {
          return {
            nodes: [
              { id: 'common', kind: 'config_entry', name: 'common' },
              { id: 'official', kind: 'config_entry', name: 'official' },
              { id: 'native', kind: 'config_entry', name: 'native' },
            ],
            edges: [],
          };
        }
        return { nodes: [], edges: [] };
      },
    };

    const target = await pickTraceTarget(
      client as any,
      'name',
      { id: 'orphan-name', kind: 'config_entry', name: 'name', path: '/repo/countries-unescaped.json', resolutionMode: 'exact' },
      { direction: 'downstream', predicates: ['CONTAINS'], pick: 2 },
    );

    expect(target.id).toBe('nested-name');
  });
});
