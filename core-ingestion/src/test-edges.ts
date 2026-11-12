// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from 'node:crypto';
import type { PatchOp } from './types.js';

/** Derive coverage evidence only from edges whose production destination resolved. */
export function appendTestEdges(
  ops: PatchOp[], testFileId: string | undefined, testSymbols: ReadonlySet<string>,
  productionIds: ReadonlySet<string>,
): void {
  if (!testFileId) return;
  const tests = new Map<string, PatchOp>();
  for (const op of ops) {
    if (op.type !== 'UpsertEdge' || (op.predicate !== 'CALLS' && op.predicate !== 'IMPORTS')
      || !productionIds.has(String(op.dst))) continue;
    const src = testSymbols.has(String(op.src)) ? String(op.src) : testFileId;
    const key = `${src}\0${op.dst}\0TESTS`;
    const attrs = op.attrs as Record<string, unknown> | undefined;
    const confidence = typeof attrs?.confidence === 'number' ? attrs.confidence : 0.5;
    const previous = tests.get(key);
    const previousAttrs = previous?.attrs as Record<string, unknown> | undefined;
    // Prefer calls to file imports, keeping the resolver's confidence.
    if (previous && ((previousAttrs?.via === 'CALLS' && op.predicate === 'IMPORTS')
      || (previousAttrs?.via === op.predicate && Number(previousAttrs?.confidence) >= confidence))) continue;
    const hash = createHash('sha256').update(key).digest('hex');
    tests.set(key, {
      type: 'UpsertEdge', id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
      src, dst: op.dst, predicate: 'TESTS', attrs: { ...attrs, confidence, via: op.predicate },
    });
  }
  ops.push(...tests.values());
}
