// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

// One data file may not flood the graph: a JSON, YAML or TOML file emits at
// most 500 config entries (YAML and TOML the first in document order) and says
// so. The JSON rules are in queries.json.test.ts.

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `k${i}`);
const entries = (filePath: string, source: string) =>
  parseFile(filePath, source)!.entities.filter(e => e.kind === 'config_entry');

function expectConsistent(filePath: string, source: string): void {
  const result = parseFile(filePath, source)!;
  const names = new Set(result.entities.filter(e => e.kind === 'config_entry').map(e => e.name));
  for (const chunk of result.chunks) expect(names.has(chunk.name!)).toBe(true);
  for (const relationship of result.relationships) {
    expect(names.has(relationship.dstName)).toBe(true);
  }
  expect(result.relationships).toHaveLength(names.size);
}

describe('the per-file limit on config entries', () => {
  it('YAML: the first 500 keys', () => {
    const source = keys(600).map(k => `${k}: 1`).join('\n');
    expect(entries('/repo/many.yaml', source).map(e => e.name)).toEqual(keys(500));
    expectConsistent('/repo/many.yaml', source);
  });

  it('TOML: the first 500 keys', () => {
    const source = keys(600).map(k => `${k} = 1`).join('\n');
    expect(entries('/repo/many.toml', source).map(e => e.name)).toEqual(keys(500));
    expectConsistent('/repo/many.toml', source);
  });

  it('TOML: a dotted header at the limit leaves no entry without its parent', () => {
    const source = [...keys(499).map(k => `${k} = 1`), '[outer.inner]', 'after = 1'].join('\n');
    const emitted = entries('/repo/edge.toml', source);
    expect(emitted).toHaveLength(500);
    expect(emitted[499]).toMatchObject({ name: 'outer' });
    expect(emitted.map(e => e.name)).not.toContain('inner');
    expect(emitted.map(e => e.name)).not.toContain('after');
    const relationships = parseFile('/repo/edge.toml', source)!.relationships;
    expect(relationships.map(r => r.dstName)).not.toContain('inner');
  });

  it('exactly 500 keys are all kept, in all three formats', () => {
    expect(entries('/repo/a.yaml', keys(500).map(k => `${k}: 1`).join('\n'))).toHaveLength(500);
    expect(entries('/repo/a.toml', keys(500).map(k => `${k} = 1`).join('\n'))).toHaveLength(500);
    expect(entries('/repo/a.json', JSON.stringify(Object.fromEntries(keys(500).map(k => [k, 1]))))).toHaveLength(500);
  });

  it('says a YAML or TOML file was capped only when a key was dropped', () => {
    const capped = (filePath: string, source: string) => parseFile(filePath, source)!.configEntriesCapped;
    expect(capped('/repo/a.yaml', keys(501).map(k => `${k}: 1`).join('\n'))).toBe(true);
    expect(capped('/repo/a.toml', keys(501).map(k => `${k} = 1`).join('\n'))).toBe(true);
    // Exactly at the limit, with only comments and blank lines after it.
    expect(capped('/repo/b.yaml', [...keys(500).map(k => `${k}: 1`), '# end', ''].join('\n'))).toBeUndefined();
    expect(capped('/repo/b.toml', [...keys(500).map(k => `${k} = 1`), '# end', ''].join('\n'))).toBeUndefined();
    // A dotted header whose parent took the last place.
    expect(capped('/repo/c.toml', [...keys(499).map(k => `${k} = 1`), '[outer.inner]'].join('\n'))).toBe(true);
  });

  it('YAML and TOML keep their depth', () => {
    const yaml = 'a:\n  b:\n    c:\n      d: 1\n';
    expect(entries('/repo/deep.yaml', yaml).map(e => e.name)).toEqual(['a', 'b', 'c', 'd']);
    const toml = '[a.b.c]\nd = 1\n';
    expect(entries('/repo/deep.toml', toml).map(e => e.name)).toEqual(['a', 'b', 'c', 'd']);
  });
});
