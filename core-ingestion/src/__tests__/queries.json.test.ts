// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { languageFromPath, SupportedLanguages } from '../languages.js';

describe('JSON parsing', () => {
  it('recognizes .json as JSON', () => {
    expect(languageFromPath('/repo/package.json')).toBe(SupportedLanguages.JSON);
    expect(languageFromPath('/repo/tsconfig.json')).toBe(SupportedLanguages.JSON);
  });

  it('parses top-level keys from a flat object', () => {
    const result = parseFile(
      '/repo/package.json',
      JSON.stringify({ name: 'my-app', version: '1.0.0', private: true }),
    );

    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.JSON);
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'name', kind: 'config_entry', language: SupportedLanguages.JSON }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'version', kind: 'config_entry' }),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'package.json',
      dstName: 'name',
      predicate: 'CONTAINS',
    });
  });

  it('parses nested object keys with correct container', () => {
    const result = parseFile(
      '/repo/config.json',
      JSON.stringify({ database: { host: 'localhost', port: 5432 } }),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'database', kind: 'config_entry', container: undefined }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'host', kind: 'config_entry', container: 'database' }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'port', kind: 'config_entry', container: 'database' }),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'database',
      dstName: 'host',
      predicate: 'CONTAINS',
    });
  });

  const configEntries = (filePath: string, source: string) =>
    parseFile(filePath, source)!.entities.filter((e) => e.kind === 'config_entry');
  const pairs = (entries: Array<{ name: string; container?: string }>) =>
    entries.map((e) => [e.container, e.name]);

  /** Every chunk and CONTAINS edge belongs to an emitted entry, and each entry has both. */
  const expectConsistent = (filePath: string, source: string) => {
    const result = parseFile(filePath, source)!;
    const entries = result.entities.filter((e) => e.kind === 'config_entry');
    const chunks = result.chunks.filter((c) => c.chunkKind === 'config_key');
    expect(chunks.map((c) => [c.container, c.name])).toEqual(pairs(entries));
    const names = new Set(entries.map((e) => e.name));
    const contains = result.relationships.filter((r) => r.predicate === 'CONTAINS');
    expect(contains).toHaveLength(entries.length);
    for (const relationship of contains) expect(names.has(relationship.dstName)).toBe(true);
  };

  it('emits keys of the first two levels and nothing deeper', () => {
    const source = JSON.stringify({ a: { b: { c: { d: 1 } }, e: 2 }, f: 3 });
    expect(pairs(configEntries('/repo/deep.json', source))).toEqual([
      [undefined, 'a'],
      ['a', 'b'],
      ['a', 'e'],
      [undefined, 'f'],
    ]);
    expectConsistent('/repo/deep.json', source);
  });

  it('emits the key holding an array and nothing inside the array', () => {
    const source = JSON.stringify({ servers: [{ host: 'a.example.com' }, { host: 'b.example.com' }] });
    expect(pairs(configEntries('/repo/servers.json', source))).toEqual([[undefined, 'servers']]);
    expectConsistent('/repo/servers.json', source);
  });

  it('keeps a file whose top level is an array, with no keys', () => {
    const result = parseFile('/repo/records.json', JSON.stringify([{ id: 1 }, { id: 2 }]))!;
    expect(result.entities.map((e) => e.kind)).toEqual(['file']);
    expect(result.chunks.map((c) => c.chunkKind)).toEqual(['file_body']);
  });

  it('stops at 500 entries, the first in document order', () => {
    const keys = Array.from({ length: 600 }, (_, i) => `k${i}`);
    const source = JSON.stringify(Object.fromEntries(keys.map((k) => [k, 1])));
    expect(configEntries('/repo/many.json', source).map((e) => e.name)).toEqual(keys.slice(0, 500));
    expectConsistent('/repo/many.json', source);
    // The limit counts second-level keys too, and can fall inside an object.
    const nested = JSON.stringify({ a: Object.fromEntries(keys.map((k) => [k, 1])), z: 1 });
    expect(configEntries('/repo/nested.json', nested).map((e) => e.name))
      .toEqual(['a', ...keys.slice(0, 499)]);
    expectConsistent('/repo/nested.json', nested);
  });

  it('keeps the keys of a package.json and a tsconfig.json', () => {
    const pkg = JSON.stringify({
      name: 'app',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { react: '^19.0.0' },
      files: ['dist'],
    });
    expect(pairs(configEntries('/repo/package.json', pkg))).toEqual([
      [undefined, 'name'],
      [undefined, 'scripts'],
      ['scripts', 'build'],
      ['scripts', 'test'],
      [undefined, 'dependencies'],
      ['dependencies', 'react'],
      [undefined, 'files'],
    ]);
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['src'] });
    expect(pairs(configEntries('/repo/tsconfig.json', tsconfig))).toEqual([
      [undefined, 'compilerOptions'],
      ['compilerOptions', 'strict'],
      ['compilerOptions', 'target'],
      [undefined, 'include'],
    ]);
  });

  it('uses fully qualified containers for repeated nested keys', () => {
    const result = parseFile(
      '/repo/countries.json',
      JSON.stringify({
        name: { common: 'Aruba' },
        currencies: { name: 'Aruban florin' },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'common', container: 'name' }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'name', container: 'currencies' }),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'currencies',
      dstName: 'name',
      predicate: 'CONTAINS',
    });
  });

  it('falls back to file_body chunk for invalid JSON', () => {
    const result = parseFile('/repo/broken.json', '{ invalid json }');

    expect(result).not.toBeNull();
    expect(result!.chunks).toHaveLength(1);
    expect(result!.chunks[0].chunkKind).toBe('file_body');
  });

  it('emits config_key chunks with content hashes', () => {
    const result = parseFile(
      '/repo/settings.json',
      JSON.stringify({ timeout: 30 }),
    );

    expect(result).not.toBeNull();
    const chunk = result!.chunks.find((c) => c.name === 'timeout');
    expect(chunk).toBeDefined();
    expect(chunk!.chunkKind).toBe('config_key');
    expect(chunk!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
