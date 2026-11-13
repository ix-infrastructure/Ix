// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Command } from 'commander';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '../../client/types.js';
import { lookupConfig, bindingCandidates } from '../config-lookup.js';
import { loadIngestionModules } from '../commands/ingestion-loader.js';
import { registerConfigCommand } from '../commands/config.js';
import { issueConfidence, pickStartingPoints, rankIssueFiles } from '../explain/issue.js';
import { createIxMcpServer } from '../../mcp/server.js';

const state = vi.hoisted(() => ({ client: undefined as any, extendedClient: undefined as any }));
vi.mock('../../client/factory.js', () => ({ createClient: () => state.client }));
vi.mock('../resolve.js', () => ({ ensureReadScope: async () => {}, activeReadScope: () => ({ workspaceId: 'ws' }) }));

beforeAll(async () => {
  const [{ parseFile }, { buildPatchWithResolution }] = await loadIngestionModules();
  const nodes: GraphNode[] = [];
  for (const file of ['app.ts', 'config.json', 'app.go', 'Controllers.java', 'chained.ts', 'chained.py', 'settings.ts', 'settings.py', 'JaxRoutes.java']) {
    const source = readFileSync(new URL(`../../../../core-ingestion/test-fixtures/config-bindings/${file}`, import.meta.url), 'utf8');
    const patch = buildPatchWithResolution(parseFile(`src/${file}`, source), 'hash', 'ws', []);
    for (const op of patch.ops.filter((op: any) => op.type === 'UpsertNode')) nodes.push({
      id: op.id, kind: op.kind, name: op.name, attrs: op.attrs,
      provenance: { sourceUri: patch.source.uri, sourceHash: patch.source.sourceHash, extractor: patch.source.extractor, sourceType: patch.source.sourceType, observedAt: patch.timestamp },
      createdRev: 1, createdAt: patch.timestamp, updatedAt: patch.timestamp,
    });
  }
  const clientFor = (nodes: GraphNode[]) => ({
    search: vi.fn(async (query: string) => nodes.filter(n => n.name.includes(query))),
    nodes: vi.fn(async (ids: string[]) => ({ rev: 1, nodes: nodes.filter(n => ids.includes(n.id)), missing: [] })),
  });
  state.client = clientFor(nodes.filter(n => ['src/app.ts', 'src/config.json'].includes(n.provenance?.sourceUri ?? '')));
  state.extendedClient = clientFor(nodes);
});
afterEach(() => vi.restoreAllMocks());

describe('config lookup over production parser patches', () => {
  it('returns reads, declarations, handlers and literal defaults', async () => {
    expect((await lookupConfig(state.client, 'APP_HOST', { workspaceId: 'ws' })).matches)
      .toContainEqual(expect.objectContaining({ kind: 'EnvVar', role: 'read', symbol: 'boot', defaultValue: 'localhost', path: 'src/app.ts' }));
    expect((await lookupConfig(state.client, 'server.http.port')).matches)
      .toContainEqual(expect.objectContaining({ role: 'declaration', defaultValue: 8080, path: 'src/config.json' }));
    expect((await lookupConfig(state.client, '/health/:id')).matches)
      .toContainEqual(expect.objectContaining({ key: 'GET /health/:id', role: 'handler', symbol: 'health' }));
    expect((await lookupConfig(state.client, '--verbose')).matches.filter(m => m.path === 'src/app.ts').map(m => m.role)).toEqual(['read', 'declaration']);
    expect(state.client.nodes).toHaveBeenCalledWith(expect.any(Array), 'full');
    expect(state.client.search).toHaveBeenCalledWith('APP_HOST', expect.objectContaining({ workspaceId: 'ws', nameOnly: true }));
  });
  it('resolves chained reads through full parser patches', async () => {
    const result = await lookupConfig(state.extendedClient, 'APP_HOST');
    for (const path of ['src/chained.ts', 'src/chained.py']) {
      expect(result.matches).toContainEqual(expect.objectContaining({ path, symbol: 'normalize', role: 'read' }));
    }
  });
  for (const path of ['src/settings.ts', 'src/settings.py']) it(`resolves chained settings and issue starts in ${path}`, async () => {
    expect((await lookupConfig(state.extendedClient, 'host')).matches)
      .toContainEqual(expect.objectContaining({ path, key: 'host', kind: 'ConfigKey', symbol: 'normalize', role: 'read' }));
    const { starts } = await pickStartingPoints('The setting `host` has no effect', {
      files: [path], search: async () => [], config: q => lookupConfig(state.extendedClient, q),
    });
    expect(starts).toContainEqual(expect.objectContaining({ path, name: 'normalize', via: 'config key' }));
  });
  for (const [query, path, key, symbol] of [
    ['GET /api/health', 'src/JaxRoutes.java', 'GET /api/health', 'JaxRoutes.health'],
    ['POST /api/jobs', 'src/JaxRoutes.java', 'POST /api/jobs', 'JaxRoutes.jobs'],
    ['GET /api/health', 'src/Controllers.java', 'GET /api/health', 'Controller.health'],
    ['POST /api/jobs', 'src/Controllers.java', 'POST /api/jobs', 'Controller.jobs'],
    ['GET /health', 'src/app.go', '* /health', 'health'],
    ['POST /health', 'src/app.go', '* /health', 'health'],
  ]) it(`looks up ${query} and supplies route issue starts`, async () => {
    expect((await lookupConfig(state.extendedClient, query)).matches).toContainEqual(expect.objectContaining({ path, key, symbol }));
    const { starts } = await pickStartingPoints(`${query} fails`, {
      files: [path], search: async () => [], config: q => lookupConfig(state.extendedClient, q),
    });
    expect(starts).toContainEqual(expect.objectContaining({ path, name: symbol, via: 'route' }));
  });
  it('keeps method-specific routes and paths exact', async () => {
    expect((await lookupConfig(state.extendedClient, 'DELETE /api/health')).matches).toEqual([]);
    expect((await lookupConfig(state.extendedClient, 'GET /healthz')).matches).toEqual([]);
    expect((await lookupConfig(state.extendedClient, 'GET /health')).matches.some(m => m.key === 'GET /health/:id')).toBe(false);
    expect((await lookupConfig(state.extendedClient, '/health')).matches).toContainEqual(expect.objectContaining({ key: '* /health' }));
  });
  it('does not treat partial names or ordinary code names as config bindings', async () => {
    expect((await lookupConfig(state.client, 'APP')).matches).toEqual([]);
    expect((await lookupConfig(state.client, 'boot')).matches).toEqual([]);
    expect((await lookupConfig(state.client, '--fake')).matches).toEqual([]);
  });
  for (const [query, reason] of [['APP_HOST', 'env var'], ['PORT', 'env var'], ['timeout', 'config key'], ['server.port', 'config key'], ['--verbose', 'flag'], ['-v', 'flag'], ['GET /health/:id', 'route']]) {
    it(`keeps ${reason} matches as confident, pinned issue starts`, async () => {
      const { starts } = await pickStartingPoints(`The \`${query}\` setting has no effect`, {
        files: ['src/app.ts'], search: async () => [], config: q => lookupConfig(state.client, q),
      });
      expect(starts).toContainEqual(expect.objectContaining({ path: 'src/app.ts', via: reason }));
      expect(issueConfidence({ starts, fallback: false }).confident).toBe(true);
      expect(rankIssueFiles({ starts, bm25: [{ path: 'src/distractor.ts', score: 100 }], near: new Map() })[0].path).toBe('src/app.ts');
    });
  }
  it('bounds and deduplicates candidates and preserves route placeholders', () => {
    expect(bindingCandidates('GET /foo/{id} fails with --dry-run and APP_HOST in server.port. APP_HOST'))
      .toEqual([{ query: 'GET /foo/{id}', reason: 'route' }, { query: '--dry-run', reason: 'flag' }, { query: 'APP_HOST', reason: 'env var' }, { query: 'server.port', reason: 'config key' }]);
    expect(bindingCandidates(Array.from({ length: 100 }, (_, i) => `APP_${i}`).join(' '))).toHaveLength(25);
    expect(bindingCandidates('setting timeout is ignored')).toContainEqual({ query: 'timeout', reason: 'config key' });
  });
  it('uses issue relevance for a widely read key and does not pin an incomplete result page', async () => {
    const recorded = await lookupConfig(state.client, 'APP_HOST');
    const files = Array.from({ length: 4 }, (_, i) => `src/reader${i}.ts`);
    const { starts } = await pickStartingPoints('APP_HOST is ignored', {
      files, search: async () => [], fileScore: path => path === files[3] ? 2 : 0,
      config: async () => ({ ...recorded, truncated: true, matches: files.map(path => ({ ...recorded.matches[0], path })) }),
    });
    expect(starts[0].path).toBe(files[3]);
    const ranked = rankIssueFiles({ starts, bm25: [{ path: 'src/other.ts', score: 100 }, { path: files[3], score: 2 }], near: new Map() });
    expect(ranked[0].path).toBe('src/other.ts');
  });
  for (const args of [['config', 'APP_HOST'], ['config', '--verbose'], ['config', '--', '--verbose'], ['config', 'lookup', '--format=json', '--', 'GET /health/:id']]) {
    it(`accepts CLI arguments ${args.join(' ')}`, async () => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const program = new Command().exitOverride();
      registerConfigCommand(program);
      await program.parseAsync(args, { from: 'user' });
      expect(output.mock.calls.flat().join('\n')).toContain(args.at(-1));
      expect(program.commands[0].commands.map(c => c.name())).toEqual(expect.arrayContaining(['show', 'get', 'set', 'prune', 'lookup']));
    });
  }
  it('runs the MCP tool through real CLI parsing, including a flag query', async () => {
    const calls: string[][] = [];
    const server = createIxMcpServer({ tools: 'all', runIx: async args => {
      calls.push(args);
      const chunks: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation(s => { chunks.push(String(s)); });
      try {
        const program = new Command().exitOverride();
        registerConfigCommand(program);
        await program.parseAsync(args, { from: 'user' });
        return { ok: true, stdout: chunks.join('\n'), stderr: '' };
      } finally { log.mockRestore(); }
    } });
    const client = new Client({ name: 'config-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool({ name: 'ix_config', arguments: { query: '--verbose' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ query: '--verbose', matches: expect.any(Array) });
      expect(calls).toEqual([['config', 'lookup', '--format=json', '--', '--verbose']]);
    } finally { await client.close(); await server.close(); }
  });
});
