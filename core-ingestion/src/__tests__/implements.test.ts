// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult } from '../index.js';
import { buildPatch, buildPatchWithResolution, extractorName, PREVIOUS_EXTRACTORS, sourcePatchIdCandidates } from '../patch-builder.js';

describe('IMPLEMENTS edges', () => {
  it.each([
    ['example.ts', 'interface I {} interface J<T> {} class Base {} class A extends Base implements I, J<string> {}'],
    ['Example.java', 'interface I {} interface J<T> {} class Base {} class A extends Base implements I, J<String> {}'],
    ['example.php', '<?php interface I {} interface J {} class Base {} class A extends Base implements I, J {}'],
  ])('distinguishes implementations from inheritance in %s', (path, source) => {
    const parsed = parseFile(path, source)!;
    expect(parsed).not.toBeNull();
    expect(parsed.relationships.filter(r => r.srcName === 'A')).toEqual(expect.arrayContaining([
      { srcName: 'A', dstName: 'Base', predicate: 'EXTENDS' },
      { srcName: 'A', dstName: 'I', predicate: 'IMPLEMENTS' },
      { srcName: 'A', dstName: 'J', predicate: 'IMPLEMENTS' },
    ]));
    const patch = buildPatch(parsed, 'hash');
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'IMPLEMENTS')).toHaveLength(2);
    expect(parsed.relationships.some(r => r.srcName === 'A' && r.dstName !== 'Base' && r.predicate === 'EXTENDS')).toBe(false);
  });

  it.each([
    ["import type { I as Renamed } from './types'; export class A implements Renamed {}", 'Renamed'],
    ["import * as ns from './types'; export class A implements ns.I {}", 'ns.I'],
  ])('resolves imported interfaces and keeps summary refs: %s', (source, dstName) => {
    const types = parseFile('/repo/types.ts', 'export interface I {}')!;
    const app = parseFile('/repo/app.ts', source)!;
    const summaries = new Map([types, app].map(p => [p.filePath, summarizeParseResult(p)]));
    expect(summaries.get(app.filePath)!.refs).toContain(dstName);
    const index = buildGlobalResolutionIndex([types.filePath, app.filePath], undefined, undefined, summaries);
    const edges = resolveEdges([app], undefined, index);
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'A', dstName, dstFilePath: types.filePath, dstQualifiedKey: 'I', predicate: 'IMPLEMENTS',
    }));
    expect(buildPatchWithResolution(app, 'hash', 'ws', edges).ops).toContainEqual(expect.objectContaining({
      type: 'UpsertEdge', predicate: 'IMPLEMENTS',
    }));
  });

  it.each([
    ['/repo/api/I.java', 'package api; public interface I {}', '/repo/app/A.java', 'package app; import api.I; class A implements I {}'],
    ['/repo/api/I.php', '<?php namespace Api; interface I {}', '/repo/app/A.php', '<?php namespace App; use Api\\I; class A implements I {}'],
  ])('resolves an imported interface from %s', (typesPath, typesSource, appPath, appSource) => {
    const types = parseFile(typesPath, typesSource)!;
    const app = parseFile(appPath, appSource)!;
    expect(resolveEdges([app, types])).toContainEqual(expect.objectContaining({
      srcName: 'A', dstFilePath: typesPath, predicate: 'IMPLEMENTS',
    }));
  });

  it('does not resolve an unbound global interface to an unrelated module type', () => {
    const app = parseFile('/repo/app.ts', 'export class A implements I {}')!;
    const moduleType = parseFile('/repo/module.ts', 'export interface I {}')!;
    expect(resolveEdges([app, moduleType]).filter(e => e.predicate === 'IMPLEMENTS')).toEqual([]);
    const ambient = parseFile('/repo/ambient.d.ts', 'interface I {}')!;
    expect(resolveEdges([app, moduleType, ambient])).toContainEqual(expect.objectContaining({
      srcName: 'A', dstFilePath: ambient.filePath, predicate: 'IMPLEMENTS',
    }));
  });

  it('preserves type-namespace import shadowing', () => {
    const types = parseFile('/repo/types.ts', 'export interface I {}')!;
    const app = parseFile('/repo/app.ts', `import type { I } from './types';
      function outer<I>() { class A implements I {} }
    `)!;
    expect(app.relationships.find(r => r.predicate === 'IMPLEMENTS')).toMatchObject({ importBinding: false });
    expect(resolveEdges([app, types]).filter(e => e.predicate === 'IMPLEMENTS')).toEqual([]);
  });

  it('supersedes the extractor that folded implementations into EXTENDS', () => {
    expect(extractorName()).not.toBe('tree-sitter/1.30');
    expect(PREVIOUS_EXTRACTORS).toContain('tree-sitter/1.30');
    const old = parseFile('example.ts', 'interface I {} class A implements I {}')!;
    old.relationships = old.relationships.map(r => r.predicate === 'IMPLEMENTS' ? { ...r, predicate: 'EXTENDS' } : r);
    const parsed = parseFile('example.ts', 'interface I {} class A implements I {}')!;
    const patch = buildPatch(parsed, 'hash', 'ws');
    const oldPatchId = sourcePatchIdCandidates('example.ts', 'hash', 'ws')[1 + PREVIOUS_EXTRACTORS.indexOf('tree-sitter/1.30')];
    expect(patch.replaces).toContain(oldPatchId);
    expect(buildPatchWithResolution(parsed, 'hash', 'ws', []).replaces).toContain(oldPatchId);
    const oldIds = new Set(buildPatch(old, 'hash', 'ws').ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'EXTENDS').map(op => op.id));
    const newEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'IMPLEMENTS');
    expect(newEdges).toHaveLength(1);
    expect(newEdges.every(op => !oldIds.has(op.id))).toBe(true);
  });
});
