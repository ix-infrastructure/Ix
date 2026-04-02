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

  it('uses fully qualified containers for repeated nested keys', () => {
    const result = parseFile(
      '/repo/countries.json',
      JSON.stringify({
        name: { common: 'Aruba' },
        currencies: { AWG: { name: 'Aruban florin' } },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'common', container: 'name' }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'name', container: 'currencies.AWG' }),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'currencies.AWG',
      dstName: 'name',
      predicate: 'CONTAINS',
    });
  });

  it('parses geojson-style keys nested inside array items', () => {
    const result = parseFile(
      '/repo/abw.geo.json',
      JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { cca2: 'aw' } }],
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'features', kind: 'config_entry' }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'properties', container: 'features' }),
    );
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'cca2', container: 'features.properties' }),
    );
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
