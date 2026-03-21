import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const scalaRoot = path.join(repoRoot, 'memory-layer/src/main/scala');

function walkScalaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkScalaFiles(fullPath);
    return entry.name.endsWith('.scala') ? [fullPath] : [];
  });
}

describe('resolveEdges integration on real Scala files', () => {
  it('resolves GraphQueryApi NodeKind references back to Node.scala', () => {
    const parsed = walkScalaFiles(scalaRoot)
      .map(filePath => {
        const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
        return parseFile(relativePath, readFileSync(filePath, 'utf8'));
      })
      .filter((result): result is NonNullable<typeof result> => result !== null);

    const resolved = resolveEdges(parsed);
    const graphQueryApiNodeKindRefs = resolved.filter(edge =>
      edge.srcFilePath.endsWith('GraphQueryApi.scala')
      && edge.predicate === 'REFERENCES'
      && edge.dstName === 'NodeKind'
    );

    expect(graphQueryApiNodeKindRefs.length).toBeGreaterThan(0);
    expect(graphQueryApiNodeKindRefs.every(edge => edge.dstFilePath.endsWith('Node.scala'))).toBe(true);
  });
});
