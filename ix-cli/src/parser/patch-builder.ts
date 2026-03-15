import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import type { GraphPatchPayload, PatchOp } from '../client/types.js';
import type { FileParseResult } from './index.js';

// ---------------------------------------------------------------------------
// Deterministic UUID from a string (matches existing CLI convention)
// ---------------------------------------------------------------------------

function deterministicId(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

function nodeId(filePath: string, name: string): string {
  return deterministicId(`${filePath}:${name}`);
}

function edgeId(filePath: string, src: string, dst: string, predicate: string): string {
  return deterministicId(`${filePath}:${src}:${dst}:${predicate}`);
}

// ---------------------------------------------------------------------------
// Source type from file extension
// ---------------------------------------------------------------------------

function sourceType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'].includes(ext)) return 'config';
  if (['.md', '.mdx', '.rst', '.txt'].includes(ext)) return 'doc';
  return 'code';
}

function extractorName(filePath: string): string {
  return `tree-sitter/1.0`;
}

// ---------------------------------------------------------------------------
// Build a GraphPatchPayload from a FileParseResult
// ---------------------------------------------------------------------------

export function buildPatch(
  result: FileParseResult,
  sourceHash: string,
  previousPatchId?: string
): GraphPatchPayload {
  const { filePath, entities, relationships } = result;
  const ops: PatchOp[] = [];

  // UpsertNode for each entity
  for (const e of entities) {
    ops.push({
      type: 'UpsertNode',
      id: nodeId(filePath, e.name),
      kind: e.kind,
      name: e.name,
      attrs: {
        line_start: e.lineStart,
        line_end: e.lineEnd,
        language: e.language,
      },
    });
  }

  // UpsertEdge for each relationship
  for (const r of relationships) {
    ops.push({
      type: 'UpsertEdge',
      id: edgeId(filePath, r.srcName, r.dstName, r.predicate),
      src: nodeId(filePath, r.srcName),
      dst: nodeId(filePath, r.dstName),
      predicate: r.predicate,
      attrs: {},
    });
  }

  // AssertClaim for each relationship (feeds the confidence/conflict engine)
  for (const r of relationships) {
    ops.push({
      type: 'AssertClaim',
      entityId: nodeId(filePath, r.srcName),
      field: `${r.predicate.toLowerCase()}:${r.dstName}`,
      value: r.dstName,
      confidence: null,
    });
  }

  const patchId = deterministicId(`${filePath}:${sourceHash}:${Date.now()}`);

  return {
    patchId,
    actor: 'ix/ingestion',
    timestamp: new Date().toISOString(),
    source: {
      uri: filePath,
      sourceHash,
      extractor: extractorName(filePath),
      sourceType: sourceType(filePath),
    },
    baseRev: 0,
    ops,
    replaces: previousPatchId ? [previousPatchId] : [],
    intent: `Parsed ${nodePath.basename(filePath)}`,
  };
}
