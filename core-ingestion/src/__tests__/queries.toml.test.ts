import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { languageFromPath, SupportedLanguages } from '../languages.js';

describe('TOML parsing', () => {
  it('recognizes .toml as TOML', () => {
    expect(languageFromPath('/repo/Cargo.toml')).toBe(SupportedLanguages.TOML);
    expect(languageFromPath('/repo/pyproject.toml')).toBe(SupportedLanguages.TOML);
  });

  it('parses top-level key = value pairs', () => {
    const result = parseFile(
      '/repo/config.toml',
      [
        'name = "my-app"',
        'version = "1.0.0"',
        'debug = false',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.TOML);
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'name',
      kind: 'config_entry',
      language: SupportedLanguages.TOML,
      container: undefined,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'version',
      kind: 'config_entry',
      container: undefined,
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'config.toml',
      dstName: 'name',
      predicate: 'CONTAINS',
    });
  });

  it('parses [table] headers and keys within them', () => {
    const result = parseFile(
      '/repo/config.toml',
      [
        '[database]',
        'host = "localhost"',
        'port = 5432',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'database',
      kind: 'config_entry',
      container: undefined,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'host',
      kind: 'config_entry',
      container: 'database',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'port',
      kind: 'config_entry',
      container: 'database',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'config.toml',
      dstName: 'database',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'database',
      dstName: 'host',
      predicate: 'CONTAINS',
    });
  });

  it('parses nested [section.subsection] tables', () => {
    const result = parseFile(
      '/repo/config.toml',
      [
        '[server.tls]',
        'cert = "/etc/ssl/cert.pem"',
        'key = "/etc/ssl/key.pem"',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    // Intermediate node
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'server',
      kind: 'config_entry',
      container: undefined,
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'tls',
      kind: 'config_entry',
      container: 'server',
    }));
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'cert',
      kind: 'config_entry',
      container: 'server.tls',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'config.toml',
      dstName: 'server',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'server',
      dstName: 'tls',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'server.tls',
      dstName: 'cert',
      predicate: 'CONTAINS',
    });
  });

  it('emits intermediate nodes for dotted table paths', () => {
    const result = parseFile(
      '/repo/Cargo.toml',
      [
        '[profile.release]',
        'lto = true',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    // Intermediate node
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'profile',
      kind: 'config_entry',
      container: undefined,
    }));
    // Leaf node
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'release',
      kind: 'config_entry',
      container: 'profile',
    }));
    // Key within leaf
    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'lto',
      kind: 'config_entry',
      container: 'profile.release',
    }));
    // Chain of CONTAINS relationships
    expect(result!.relationships).toContainEqual({
      srcName: 'Cargo.toml',
      dstName: 'profile',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'profile',
      dstName: 'release',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'profile.release',
      dstName: 'lto',
      predicate: 'CONTAINS',
    });
  });

  it('does not duplicate intermediate nodes across sibling table headers', () => {
    const result = parseFile(
      '/repo/Cargo.toml',
      [
        '[profile.release]',
        'lto = true',
        '[profile.dev]',
        'opt-level = 0',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    const profileNodes = result!.entities.filter(e => e.name === 'profile');
    expect(profileNodes).toHaveLength(1);
  });

  it('parses [[array-of-tables]] headers', () => {
    const result = parseFile(
      '/repo/config.toml',
      [
        '[[servers]]',
        'name = "alpha"',
        '',
        '[[servers]]',
        'name = "beta"',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    // Both [[servers]] headers produce a 'servers' entity
    const serverEntities = result!.entities.filter(e => e.name === 'servers');
    expect(serverEntities.length).toBe(2);
    expect(result!.entities.filter(e => e.name === 'name').length).toBe(2);
  });

  it('ignores comment lines and blank lines', () => {
    const result = parseFile(
      '/repo/config.toml',
      [
        '# This is a comment',
        '',
        'key = "value"',
        '# another comment',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    const nonFileEntities = result!.entities.filter(e => e.kind !== 'file');
    expect(nonFileEntities).toHaveLength(1);
    expect(nonFileEntities[0].name).toBe('key');
  });

  it('produces a file_body chunk for empty or comment-only files', () => {
    const result = parseFile('/repo/config.toml', '# just a comment\n');

    expect(result).not.toBeNull();
    expect(result!.chunks).toHaveLength(1);
    expect(result!.chunks[0].chunkKind).toBe('file_body');
  });

  it('produces config_key chunks with content hashes', () => {
    const result = parseFile('/repo/Cargo.toml', 'name = "my-crate"\n');

    expect(result).not.toBeNull();
    expect(result!.chunks).toContainEqual(expect.objectContaining({
      name: 'name',
      chunkKind: 'config_key',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('parses a realistic Cargo.toml', () => {
    const result = parseFile(
      '/repo/Cargo.toml',
      [
        '[package]',
        'name = "my-crate"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[dependencies]',
        'serde = { version = "1", features = ["derive"] }',
        'tokio = "1"',
      ].join('\n'),
    );

    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'package' }));
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'name', container: 'package' }));
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'dependencies' }));
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'serde', container: 'dependencies' }));
    expect(result!.entities).toContainEqual(expect.objectContaining({ name: 'tokio', container: 'dependencies' }));
  });
});
