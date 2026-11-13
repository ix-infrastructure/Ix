// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseFile, resolveEdges, normalizeMessage, messageMatches } from '../index.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';

const fixture = (name: string) => readFileSync(new URL(`../../test-fixtures/error-sites/${name}`, import.meta.url), 'utf8');

describe('error-site index', () => {
  it.each([
    ['fail.ts', 'TypeError', 2], ['fail.js', 'TypeError', 2],
    ['fail.py', 'ValueError', 2], ['fail.go', 'fmt.Errorf', 6],
    ['Failure.java', 'IllegalArgumentException', 3],
  ])('indexes literal templates and enclosing functions in %s', (file, errorType, line) => {
    const parsed = parseFile(file as string, fixture(file as string))!;
    expect(parsed.errorSites).toContainEqual(expect.objectContaining({
      errorType, messageTemplate: 'Invalid record {}: missing field', functionName: 'fail', line,
    }));
    for (const patch of [buildPatch(parsed, 'hash', 'ws'), buildPatchWithResolution(parsed, 'hash', 'ws', resolveEdges([parsed]))]) {
      const caller = patch.ops.find(op => op.type === 'UpsertNode' && op.name === 'fail');
      const type = patch.ops.find(op => op.type === 'UpsertNode' && op.name === errorType);
      expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', src: caller?.id, dst: type?.id, predicate: 'RAISES' }));
      expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertNode', name: 'Invalid record {}: missing field' }));
    }
  });

  it.each(['idioms.ts', 'idioms.py', 'Logging.java'])('indexes log calls and formatted throws in %s without indexing text/comments', file => {
    const sites = parseFile(file, fixture(file))!.errorSites!;
    expect(sites.map(s => s.messageTemplate)).toEqual([
      'Unable to decode record {}', 'Discarded invalid record {}', 'Unsupported record {}: invalid type',
      ...(file === 'idioms.ts' ? [undefined] : []),
    ]);
    expect(sites.every(s => s.functionName === 'validate' || s.functionName === 'dynamic')).toBe(true);
  });

  it('indexes Go error constructors and preserves multiple locations on one RAISES edge', () => {
    const parsed = parseFile('idioms.go', fixture('idioms.go'))!;
    expect(parsed.errorSites?.map(s => [s.errorType, s.messageTemplate])).toEqual([
      ['slog.Warn', 'Discarded invalid record'],
      ['errors.New', 'Cannot decode empty record'], ['fmt.Errorf', 'Unsupported record {}: invalid type'],
    ]);
    const repeated = parseFile('fail.py', fixture('fail.py').replace('    raise', '    if value:\n        raise')
      .replace('\n\nfail', '\n    raise ValueError("Cannot decode empty record")\n\nfail'))!;
    const patch = buildPatch(repeated, 'hash', 'ws');
    const raises = patch.ops.filter(op => op.predicate === 'RAISES');
    expect(raises).toHaveLength(1);
    expect((raises[0].attrs as { sites: unknown[] }).sites).toHaveLength(2);
  });

  it('normalizes printf, brace and interpolation placeholders and bounds rendered matches', () => {
    expect(normalizeMessage('record %s %d %.2f %(name)s %w {} {name} {0!r} ${value}')).toBe('record {} {} {} {} {} {} {} {} {}');
    expect(normalizeMessage('progress 100%%')).toBe('progress 100%');
    expect(messageMatches('Unsupported record {}: invalid type', 'Error: Unsupported record sample: invalid type')).toBe(true);
    expect(messageMatches('Unsupported record {}: invalid type', 'Unsupported record ' + 'x'.repeat(300) + ': invalid type')).toBe(false);
    expect(messageMatches('Unsupported record {}: invalid type', 'Unsupported record sample: invalid types')).toBe(false);
    expect(messageMatches('{} failed', 'anything failed')).toBe(false);
    expect(messageMatches('{}{} record cannot be decoded', 'a '.repeat(5000))).toBe(false);
  });
});
