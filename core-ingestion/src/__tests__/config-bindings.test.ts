// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../index.js';
import { buildPatch, buildPatchWithResolution, sourcePatchIdCandidates } from '../patch-builder.js';

const fixture = (name: string) => readFileSync(new URL(`../../test-fixtures/config-bindings/${name}`, import.meta.url), 'utf8');
const parse = (name: string) => parseFile(name, fixture(name))!;

describe('configuration bindings from real source', () => {
  for (const language of ['ts', 'js', 'py']) it(`keeps settings reads before method calls in ${language}`, () => {
    const result = parseFile(`settings.${language}`, fixture(language === 'py' ? 'settings.py' : 'settings.ts'))!;
    const facts = result.configBindings!.filter(f => f.kind === 'ConfigKey');
    const keys = ['host', 'server.host', language === 'py' ? 'port.real' : 'port', 'token'];
    expect(facts.map(f => f.key).sort()).toEqual(keys.sort());
    expect(facts.every(f => f.role === 'read' && f.symbol === 'normalize')).toBe(true);
    const patch = buildPatch(result, 'h', 'ws', undefined, { configNodeKinds: ['ConfigKey', 'EnvVar', 'CliFlag', 'Route'] });
    const host = patch.ops.find(op => op.type === 'UpsertNode' && op.kind === 'ConfigKey' && op.name === 'host')!;
    const reader = patch.ops.find(op => op.type === 'UpsertNode' && op.name === 'normalize')!;
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', src: reader.id, dst: host.id, predicate: 'READS_CONFIG' }));
  });
  for (const namespace of ['jakarta', 'javax']) it(`combines ${namespace} JAX-RS class and method paths`, () => {
    const result = parseFile('JaxRoutes.java', fixture('JaxRoutes.java').replaceAll('jakarta', namespace))!;
    const facts = result.configBindings!.filter(f => f.kind === 'Route');
    expect(facts.map(f => [f.key, f.symbol]).sort()).toEqual([
      ['GET /api/health', 'JaxRoutes.health'], ['POST /api/jobs', 'JaxRoutes.jobs'],
      ['GET /api/', 'JaxRoutes.root'], ['GET /plain', 'PlainJax.health'],
      ['GET /v1/health', 'RelativeJax.health'],
    ].sort());
    const patch = buildPatch(result, 'h', 'ws', undefined, { configNodeKinds: ['ConfigKey', 'EnvVar', 'CliFlag', 'Route'] });
    const route = patch.ops.find(op => op.type === 'UpsertNode' && op.name === 'GET /api/health')!;
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', dst: route.id, predicate: 'HANDLES_ROUTE' }));
  });
  for (const file of ['chained.ts', 'chained.py']) it(`keeps chained environment reads in ${file}`, () => {
    const result = parse(file);
    const facts = result.configBindings!.filter(f => f.kind === 'EnvVar');
    expect(facts.filter(f => f.key === 'APP_HOST')).toHaveLength(2);
    expect(facts).toContainEqual(expect.objectContaining({ key: 'APP_PORT', symbol: 'normalize' }));
    expect(facts.some(f => /FAKE|WRITE_ONLY/.test(f.key))).toBe(false);
    const patch = buildPatch(result, 'h', 'ws', undefined, { configNodeKinds: ['ConfigKey', 'EnvVar', 'CliFlag', 'Route'] });
    const env = patch.ops.find(op => op.type === 'UpsertNode' && op.name === 'APP_HOST')!;
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', dst: env.id, predicate: 'READS_CONFIG' }));
  });
  it('combines static Spring controller prefixes with method mappings', () => {
    const facts = parse('Controllers.java').configBindings!.filter(f => f.kind === 'Route');
    expect(facts).toHaveLength(12);
    expect(facts).toContainEqual(expect.objectContaining({ key: 'GET /api/health', symbol: 'Controller.health' }));
    expect(facts).toContainEqual(expect.objectContaining({ key: 'POST /api/jobs', symbol: 'Controller.jobs' }));
    expect(facts).toContainEqual(expect.objectContaining({ key: 'GET /api', symbol: 'Controller.root' }));
    for (const prefix of ['/v1', '/v2']) for (const path of ['/items', '/jobs/']) for (const verb of ['GET', 'POST']) {
      expect(facts).toContainEqual(expect.objectContaining({ key: `${verb} ${prefix}${path}`, symbol: 'Versioned.items' }));
    }
    expect(facts).toContainEqual(expect.objectContaining({ key: 'GET /health', symbol: 'Plain.health' }));
  });
  for (const [file, expected] of [
    ['flags.ts', ['direct', 'readOptions', 'serve']],
    ['flags.py', ['clicked', 'run', 'typed']],
    ['Flags.java', ['Flags.explicit', 'Flags.run']],
    ['flags.go', ['run', 'setup']],
  ] as const) it(`links only declaration-bound flag consumers in ${file}`, () => {
    const result = parse(file);
    const facts = result.configBindings!.filter(f => f.kind === 'CliFlag' && f.role === 'read');
    expect([...new Set(facts.map(f => f.symbol))].sort()).toEqual([...expected].sort());
    if (file !== 'flags.ts') expect(facts).toContainEqual(expect.objectContaining({ key: '--output-dir' }));
    const patch = buildPatch(result, 'h', 'ws');
    const nodes = new Map(patch.ops.filter(op => op.type === 'UpsertNode').map(op => [op.id, op.name]));
    const consumers = patch.ops.filter(op => op.attrs?.binding_predicate === 'CONSUMES_FLAG').map(op => nodes.get(op.src));
    expect([...new Set(consumers)].sort()).toEqual([...expected].map(s => s.split('.').at(-1)).sort());
  });
  for (const file of ['app.ts', 'app.js', 'app.py', 'app.go', 'App.java']) {
    it(`extracts the four kinds in ${file}, without string-lookalike facts`, () => {
      const facts = parse(file).configBindings ?? [];
      expect(new Set(facts.map(f => f.kind))).toEqual(new Set(['EnvVar', 'ConfigKey', 'CliFlag', 'Route']));
      expect(facts.some(f => f.key === 'APP_HOST' && f.symbol.endsWith('boot'))).toBe(true);
      expect(facts.some(f => /FAKE|fake|not-a-route/.test(f.key))).toBe(false);
    });
  }
  const frameworks: Array<[string, string, string, string]> = [
    ['commander', 'app.ts', '--verbose', 'serve'],
    ['yargs', 'app.ts', '--limit', 'serve'],
    ['express', 'app.ts', 'GET /health/:id', 'health'],
    ['express route builder', 'app.ts', 'POST /chained', 'health'],
    ['fastify', 'app.ts', 'POST /jobs', 'health'],
    ['CommonJS express', 'app.js', 'GET /commonjs', 'health'],
    ['argparse', 'app.py', '--count', 'run'],
    ['click', 'app.py', '--verbose', 'main'],
    ['typer', 'app.py', '--limit', 'typed'],
    ['flask', 'app.py', 'POST /health/<id>', 'health'],
    ['fastapi', 'app.py', 'GET /items/{id}', 'item'],
    ['django path', 'app.py', '* jobs/<int:id>/', 'health'],
    ['django re_path', 'app.py', '* ^jobs/$', 'health'],
    ['flag', 'app.go', '--host', 'setup'],
    ['pflag', 'app.go', '--verbose', 'setup'],
    ['cobra', 'app.go', '--count', 'run'],
    ['net/http', 'app.go', '* /health', 'health'],
    ['gin', 'app.go', 'GET /gin/:id', 'ginHealth'],
    ['echo', 'app.go', 'POST /echo/:id', 'echoHealth'],
    ['chi', 'app.go', 'GET /chi/{id}', 'health'],
    ['picocli', 'App.java', '--verbose', 'App.run'],
    ['spring GetMapping', 'App.java', 'GET /health/{id}', 'App.health'],
    ['spring RequestMapping', 'App.java', 'POST /jobs', 'App.jobs'],
    ['jax-rs', 'App.java', 'GET /items/{id}', 'App.item'],
  ];
  for (const [framework, file, key, symbol] of frameworks) it(`detects ${framework}`, () => {
    expect(parse(file).configBindings).toContainEqual(expect.objectContaining({ key, symbol }));
  });
  for (const ext of ['json', 'yaml', 'toml']) {
    it(`retains the full config path and literal default in ${ext}`, () => {
      expect(parse(`config.${ext}`).configBindings).toContainEqual(expect.objectContaining({
        kind: 'ConfigKey', key: 'server.http.port', defaultValue: 8080, role: 'declaration',
      }));
    });
  }
  it('links framework routes and flags to their handler', () => {
    expect(parse('app.ts').configBindings).toContainEqual(expect.objectContaining({ kind: 'Route', key: 'GET /health/:id', symbol: 'health' }));
    expect(parse('app.py').configBindings).toContainEqual(expect.objectContaining({ kind: 'Route', key: 'POST /health/<id>', symbol: 'health' }));
    expect(parse('app.go').configBindings).toContainEqual(expect.objectContaining({ kind: 'CliFlag', key: '--count', symbol: 'run', role: 'read' }));
    expect(parse('app.go').configBindings).toContainEqual(expect.objectContaining({ kind: 'CliFlag', key: '--host', symbol: 'setup', role: 'read' }));
    expect(parse('App.java').configBindings).toContainEqual(expect.objectContaining({ kind: 'Route', key: 'GET /items/{id}', symbol: 'App.item' }));
    expect(parse('app.ts').configBindings!.some(f => f.key === 'GET /chained')).toBe(false);
  });
  it('recognizes Next app route file exports', () => {
    expect(parseFile('app/api/items/[id]/route.ts', fixture('route.ts'))!.configBindings)
      .toContainEqual(expect.objectContaining({ kind: 'Route', key: 'GET /api/items/[id]', symbol: 'GET' }));
    const root = parseFile('app/route.ts', fixture('route.ts'))!;
    expect(root.configBindings).toContainEqual(expect.objectContaining({ key: 'PATCH /', symbol: 'PATCH' }));
    expect(root.configBindings!.some(f => f.key.startsWith('POST '))).toBe(false);
  });
  it('emits navigable compatibility nodes and specialized nodes only with capability', () => {
    const result = parse('app.ts');
    for (const builder of [buildPatch, (r: typeof result, h: string, w: string, _p?: string, options?: any) => buildPatchWithResolution(r, h, w, [], undefined, options)]) {
      const legacy = builder(result, 'hash', 'ws');
      expect(legacy.ops).toContainEqual(expect.objectContaining({ type: 'UpsertNode', kind: 'config_entry', name: 'APP_HOST' }));
      expect(legacy.ops.some(op => op.kind === 'EnvVar')).toBe(false);
      const patch = builder(result, 'hash', 'ws', undefined, { configNodeKinds: ['ConfigKey', 'EnvVar', 'CliFlag', 'Route'] });
      expect(patch.patchId).not.toBe(legacy.patchId);
      expect(sourcePatchIdCandidates(result.filePath, 'hash', 'ws')).toEqual(expect.arrayContaining([patch.patchId, legacy.patchId]));
      expect(patch.replaces).toContain(legacy.patchId);
      expect(legacy.replaces).toContain(patch.patchId);
      expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertNode', kind: 'EnvVar', name: 'APP_HOST' }));
      expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', predicate: 'READS_CONFIG' }));
      const ids = new Set(patch.ops.filter(op => op.type === 'UpsertNode').map(op => op.id));
      expect(patch.ops.filter(op => op.type === 'UpsertEdge').every(op => ids.has(op.src) && ids.has(op.dst))).toBe(true);
    }
  });
  it('keeps binding identities stable standalone and inside a multi-repo system', () => {
    const source = fixture('app.ts');
    const options = { configNodeKinds: ['ConfigKey', 'EnvVar', 'CliFlag', 'Route'] };
    const solo = buildPatch(parseFile('src/app.ts', source)!, 'h', 'ws', undefined, options);
    const system = buildPatch(parseFile('member/src/app.ts', source)!, 'h', 'ws', undefined, { ...options, systemId: 'system', repoId: 'member' });
    const bindings = (patch: typeof solo) => patch.ops.filter(op => (op.attrs as any)?.binding_kind || (op.attrs as any)?.binding_predicate);
    expect(bindings(system)).toEqual(bindings(solo));
    expect(system.ops.map(op => [op.id, op.src, op.dst])).toEqual(solo.ops.map(op => [op.id, op.src, op.dst]));
  });
  it('uses compatibility kinds if capability support is partial', () => {
    const patch = buildPatch(parse('app.ts'), 'h', 'ws', undefined, { configNodeKinds: ['EnvVar'] });
    expect(patch.ops.filter(op => op.type === 'UpsertNode' && (op.attrs as any)?.binding_kind).every(op => op.kind === 'config_entry')).toBe(true);
  });
});
