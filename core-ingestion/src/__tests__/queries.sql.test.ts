// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// SQL is parsed by hand (no tree-sitter grammar), so it is always available.

const SAMPLE = `-- schema
CREATE TABLE users (
  id INT PRIMARY KEY,
  org_id INT REFERENCES orgs(id)
);

-- CREATE TABLE ghost (id INT);
CREATE OR REPLACE VIEW active_users AS
SELECT u.* FROM users u JOIN orgs o ON o.id = u.org_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org ON users (org_id);

/* CREATE VIEW phantom AS SELECT 1; */
CREATE PROCEDURE archive_users()
BEGIN
  INSERT INTO users_archive SELECT * FROM users;
END;
`;

function parse() {
  const failures: string[] = [];
  const result = parseFile('/repo/db/schema.sql', SAMPLE, {
    onFailure: failure => failures.push(failure.message),
  });
  expect(failures).toEqual([]);
  expect(result).not.toBeNull();
  return result!;
}

describe('SQL parser', () => {
  it('detects SQL by extension and always supports it', () => {
    expect(isGrammarSupported('schema.sql')).toBe(true);
    expect(parse().language).toBe(SupportedLanguages.SQL);
  });

  it('captures tables, views, indexes and procedures where they start', () => {
    const entities = parse().entities
      .filter(entity => entity.kind !== 'file')
      .map(entity => `${entity.kind}:${entity.name}:${entity.lineStart}`);
    expect(entities).toEqual([
      'table:users:2',
      'view:active_users:8',
      'config_entry:idx_users_org:11',
      'function:archive_users:14',
    ]);
  });

  it('ends a multi-line statement at its semicolon', () => {
    const spans = parse().entities
      .filter(entity => entity.kind === 'table' || entity.kind === 'view')
      .map(entity => `${entity.name}:${entity.lineStart}-${entity.lineEnd}`);
    expect(spans).toEqual(['users:2-5', 'active_users:8-9']);
  });

  it('ignores CREATE statements inside comments', () => {
    const names = parse().entities.map(entity => entity.name);
    expect(names).not.toContain('ghost');
    expect(names).not.toContain('phantom');
  });

  it('links the file to every object it creates', () => {
    const contained = parse().relationships
      .filter(rel => rel.predicate === 'CONTAINS' && rel.srcName === 'schema.sql')
      .map(rel => rel.dstName);
    expect(contained).toEqual(['users', 'active_users', 'idx_users_org', 'archive_users']);
  });

  it('captures the tables a view, an index and a procedure reference', () => {
    const refs = parse().relationships
      .filter(rel => rel.predicate === 'REFERENCES')
      .map(rel => `${rel.srcName} -> ${rel.dstName}`);
    expect(refs).toEqual(expect.arrayContaining([
      'active_users -> users',
      'active_users -> orgs',
      'idx_users_org -> users',
      'archive_users -> users_archive',
      'archive_users -> users',
    ]));
  });

  it('emits one chunk per created object', () => {
    const chunks = parse().chunks.map(chunk => `${chunk.chunkKind}:${chunk.name}`);
    expect(chunks).toEqual(expect.arrayContaining([
      'create_table:users',
      'create_view:active_users',
      'create_index:idx_users_org',
      'create_function:archive_users',
    ]));
  });
});
