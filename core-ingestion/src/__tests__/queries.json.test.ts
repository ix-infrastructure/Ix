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

  it('parses keys inside array items', () => {
    const result = parseFile(
      '/repo/servers.json',
      JSON.stringify({ servers: [{ host: 'a.example.com' }, { host: 'b.example.com' }] }),
    );

    expect(result).not.toBeNull();
    const hostEntities = result!.entities.filter((e) => e.name === 'host');
    expect(hostEntities.length).toBe(2);
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
