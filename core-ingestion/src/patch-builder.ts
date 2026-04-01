import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import type { GraphPatchPayload, PatchOp } from './types.js';
import type { FileParseResult, ParsedEntity, ResolvedEdge } from './index.js';

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

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function nodeId(filePath: string, name: string): string {
  return deterministicId(`${normalizePath(filePath)}:${name}`);
}

function edgeId(filePath: string, src: string, dst: string, predicate: string): string {
  return deterministicId(`${normalizePath(filePath)}:${src}:${dst}:${predicate}`);
}

/** Deterministic ID for a chunk — keyed on file + kind + name + start line to survive minor edits. */
function chunkId(filePath: string, chunkKind: string, name: string | null, startLine: number): string {
  return deterministicId(`${normalizePath(filePath)}:chunk:${chunkKind}:${name ?? 'file_body'}:${startLine}`);
}

// ---------------------------------------------------------------------------
// Source type from file extension
// ---------------------------------------------------------------------------

function sourceType(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (fileName === 'dockerfile' || fileName.endsWith('.dockerfile')) return 'config';
  const dotIndex = fileName.lastIndexOf('.');
  const ext = dotIndex === -1 ? '' : fileName.slice(dotIndex);
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'].includes(ext)) return 'config';
  if (['.md', '.mdx', '.rst', '.txt'].includes(ext)) return 'doc';
  return 'code';
}

export function extractorName(): string {
  return `tree-sitter/1.20`;
}

/** Previous extractor versions — their patches are superseded when re-ingesting. */
export const PREVIOUS_EXTRACTORS = ['tree-sitter/1.19', 'tree-sitter/1.18', 'tree-sitter/1.17', 'tree-sitter/1.16', 'tree-sitter/1.15', 'tree-sitter/1.14', 'tree-sitter/1.13', 'tree-sitter/1.12', 'tree-sitter/1.11', 'tree-sitter/1.10', 'tree-sitter/1.9', 'tree-sitter/1.8', 'tree-sitter/1.7', 'tree-sitter/1.6', 'tree-sitter/1.5', 'tree-sitter/1.4', 'tree-sitter/1.3', 'tree-sitter/1.2', 'tree-sitter/1.1'];

/** Compute a patchId for a (filePath, sourceHash, extractorVersion) triple. */
function computePatchId(filePath: string, sourceHash: string, extractor: string): string {
  return deterministicId(`${normalizePath(filePath)}:${sourceHash}:${extractor}`);
}

/** Compute the legacy patchId (pre-1.1 scheme, no extractor suffix). */
function legacyPatchId(filePath: string, sourceHash: string): string {
  return deterministicId(`${filePath}:${sourceHash}`);
}

// ---------------------------------------------------------------------------
// Build a GraphPatchPayload from a FileParseResult
// ---------------------------------------------------------------------------

export function buildPatch(
  result: FileParseResult,
  sourceHash: string,
  previousSourceHash?: string
): GraphPatchPayload {
  const { filePath, entities, chunks, relationships } = result;
  const ops: PatchOp[] = [];

  // Build a qualified-key map so that same-named entities in different
  // enclosing classes within the same file get distinct nodeIds.
  // e.g.  ClassA.update  vs  ClassB.update  instead of both being "update".
  const entityQKey = new Map<ParsedEntity, string>();
  for (const e of entities) {
    entityQKey.set(e, e.container ? `${e.container}.${e.name}` : e.name);
  }

  // Reverse lookup: plain name → list of qualified keys (for edge resolution).
  const nameToQKeys = new Map<string, string[]>();
  for (const [e, qk] of entityQKey) {
    const list = nameToQKeys.get(e.name) ?? [];
    list.push(qk);
    nameToQKeys.set(e.name, list);
  }

  // Resolve a relationship endpoint to the best qualified key.
  // For unambiguous names (appear once), returns the single qualified key.
  // For ambiguous names (appear multiple times), falls back to the plain name
  // so that the edge still points to *something* deterministic.
  function resolveKey(name: string, container?: string): string {
    const rawKeys = nameToQKeys.get(name);
    if (!rawKeys) return name;
    // Deduplicate: @overload in Python (and similar patterns in other languages)
    // produces multiple definitions with identical qualified keys. A Set collapses
    // these so we don't mistake three `Session.execute` overloads for ambiguity.
    const keys = [...new Set(rawKeys)];
    if (keys.length === 1) return keys[0];
    // More than one distinct entity with this name — try to pick by container
    if (container) {
      const qualified = `${container}.${name}`;
      if (keys.includes(qualified)) return qualified;
    }
    // Ambiguous: return plain name so we don't silently drop the edge
    return name;
  }

  // UpsertNode for each entity (deduplicated by id — last occurrence wins)
  const seenNodeIds = new Set<string>();
  for (const e of entities) {
    const qk = entityQKey.get(e)!;
    const id = nodeId(filePath, qk);
    if (!seenNodeIds.has(id)) {
      seenNodeIds.add(id);
      const roleAttrs = e.kind === 'file'
        ? { role: result.fileRole.role, role_confidence: result.fileRole.role_confidence, role_signals: result.fileRole.role_signals }
        : { role: result.fileRole.role, role_source: 'inherited_from_file' };
      ops.push({
        type: 'UpsertNode',
        id,
        kind: e.kind,
        name: e.name,
        attrs: {
          line_start: e.lineStart,
          line_end: e.lineEnd,
          language: e.language,
          ...roleAttrs,
        },
      });
    }
  }

  // UpsertNode + edges for each chunk
  const fileNodeId = nodeId(filePath, entities.find(e => e.kind === 'file')?.name ?? filePath);
  for (const chunk of chunks) {
    const cid = chunkId(filePath, chunk.chunkKind, chunk.name, chunk.lineStart);
    const chunkName = chunk.name ?? `file_body:${chunk.lineStart}`;
    ops.push({
      type: 'UpsertNode',
      id: cid,
      kind: 'chunk',
      name: chunkName,
      attrs: {
        file_uri: filePath,
        language: chunk.language,
        chunk_kind: chunk.chunkKind,
        start_line: chunk.lineStart,
        end_line: chunk.lineEnd,
        start_byte: chunk.startByte,
        end_byte: chunk.endByte,
        content_hash: chunk.contentHash,
        parser_version: extractorName(),
      },
    });
    // File -[CONTAINS]-> Chunk
    ops.push({
      type: 'UpsertEdge',
      id: edgeId(filePath, 'file', chunkName, 'CONTAINS_CHUNK'),
      src: fileNodeId,
      dst: cid,
      predicate: 'CONTAINS_CHUNK',
      attrs: {},
    });
    // Chunk -[DEFINES]-> Symbol (only for named chunks)
    if (chunk.name !== null) {
      const symbolKey = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
      const symbolNid = nodeId(filePath, symbolKey);
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(filePath, chunkName, symbolKey, 'DEFINES'),
        src: cid,
        dst: symbolNid,
        predicate: 'DEFINES',
        attrs: {},
      });
    }
  }

  // NEXT edges for source-order chunk adjacency
  for (let i = 0; i + 1 < chunks.length; i++) {
    const a = chunks[i];
    const b = chunks[i + 1];
    // Only link top-level chunks (no container) to avoid intra-class ordering noise
    if (a.container == null && b.container == null) {
      const aid = chunkId(filePath, a.chunkKind, a.name, a.lineStart);
      const bid = chunkId(filePath, b.chunkKind, b.name, b.lineStart);
      const aName = a.name ?? `file_body:${a.lineStart}`;
      const bName = b.name ?? `file_body:${b.lineStart}`;
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(filePath, aName, bName, 'NEXT'),
        src: aid,
        dst: bid,
        predicate: 'NEXT',
        attrs: {},
      });
    }
  }

  // UpsertEdge for each relationship
  for (const r of relationships) {
    // For CONTAINS edges, srcName is the container of dstName — use that to disambiguate.
    const srcKey = resolveKey(r.srcName);
    const dstKey = r.predicate === 'CONTAINS'
      ? resolveKey(r.dstName, r.srcName)
      : resolveKey(r.dstName);

    ops.push({
      type: 'UpsertEdge',
      id: edgeId(filePath, srcKey, dstKey, r.predicate),
      src: nodeId(filePath, srcKey),
      dst: nodeId(filePath, dstKey),
      predicate: r.predicate,
      attrs: {},
    });
  }

  // AssertClaim for each relationship (feeds the confidence/conflict engine)
  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    ops.push({
      type: 'AssertClaim',
      entityId: nodeId(filePath, srcKey),
      field: `${r.predicate.toLowerCase()}:${r.dstName}`,
      value: r.dstName,
      confidence: null,
    });
  }

  // patchId is deterministic: same file + same content + same extractor → same id.
  const extractor = extractorName();
  const patchId = computePatchId(filePath, sourceHash, extractor);
  // When re-ingesting with new extractor version, replace the old patch so the
  // server accepts the new ops rather than deduplicating on the old patchId.
  const previousPatchId = previousSourceHash
    ? computePatchId(filePath, previousSourceHash, extractor)
    : legacyPatchId(filePath, sourceHash);
  // Also supersede any patches created by previous extractor versions for the same file+content.
  const replaces = [previousPatchId, ...PREVIOUS_EXTRACTORS.map(prev => computePatchId(filePath, sourceHash, prev))];

  return {
    patchId,
    actor: 'ix/ingestion',
    timestamp: new Date().toISOString(),
    source: {
      uri: filePath,
      sourceHash,
      extractor,
      sourceType: sourceType(filePath),
    },
    baseRev: 0,
    ops,
    replaces,
    intent: `Parsed ${nodePath.basename(filePath)}`,
  };
}

// ---------------------------------------------------------------------------
// buildPatchWithResolution — like buildPatch but fixes CALLS edge dst to point
// to the actual defining file for cross-file calls resolved by resolveCallEdges.
// ---------------------------------------------------------------------------

export function buildPatchWithResolution(
  result: FileParseResult,
  sourceHash: string,
  resolvedEdges: ResolvedEdge[],
  previousSourceHash?: string,
): GraphPatchPayload {
  // Build lookup: `${srcName}:${predicate}:${dstName}` → { dstFilePath, dstQualifiedKey }
  // Callers should pass only edges for this file (pre-grouped) for best performance,
  // but we still tolerate the full array for backward compatibility.
  const edgeResolution = new Map<string, { dstFilePath: string; dstQualifiedKey: string }>();
  for (const edge of resolvedEdges) {
    if (edge.srcFilePath !== result.filePath) continue;
    edgeResolution.set(`${edge.srcName}:${edge.predicate}:${edge.dstName}`, {
      dstFilePath: edge.dstFilePath,
      dstQualifiedKey: edge.dstQualifiedKey,
    });
  }

  const { filePath, entities, chunks, relationships } = result;
  const ops: PatchOp[] = [];

  const entityQKey = new Map<ParsedEntity, string>();
  for (const e of entities) {
    entityQKey.set(e, e.container ? `${e.container}.${e.name}` : e.name);
  }

  const nameToQKeys = new Map<string, string[]>();
  for (const [e, qk] of entityQKey) {
    const list = nameToQKeys.get(e.name) ?? [];
    list.push(qk);
    nameToQKeys.set(e.name, list);
  }

  function resolveKey(name: string, container?: string): string {
    const rawKeys = nameToQKeys.get(name);
    if (!rawKeys) return name;
    const keys = [...new Set(rawKeys)]; // deduplicate — @overload produces identical qks
    if (keys.length === 1) return keys[0];
    if (container) {
      const qualified = `${container}.${name}`;
      if (keys.includes(qualified)) return qualified;
    }
    return name;
  }

  const seenNodeIds2 = new Set<string>();
  for (const e of entities) {
    const qk = entityQKey.get(e)!;
    const id = nodeId(filePath, qk);
    if (!seenNodeIds2.has(id)) {
      seenNodeIds2.add(id);
      const roleAttrs = e.kind === 'file'
        ? { role: result.fileRole.role, role_confidence: result.fileRole.role_confidence, role_signals: result.fileRole.role_signals }
        : { role: result.fileRole.role, role_source: 'inherited_from_file' };
      ops.push({
        type: 'UpsertNode',
        id,
        kind: e.kind,
        name: e.name,
        attrs: { line_start: e.lineStart, line_end: e.lineEnd, language: e.language, ...roleAttrs },
      });
    }
  }

  // UpsertNode + edges for each chunk (same logic as buildPatch)
  const fileNodeId2 = nodeId(filePath, entities.find(e => e.kind === 'file')?.name ?? filePath);
  for (const chunk of chunks) {
    const cid = chunkId(filePath, chunk.chunkKind, chunk.name, chunk.lineStart);
    const chunkName = chunk.name ?? `file_body:${chunk.lineStart}`;
    ops.push({
      type: 'UpsertNode',
      id: cid,
      kind: 'chunk',
      name: chunkName,
      attrs: {
        file_uri: filePath,
        language: chunk.language,
        chunk_kind: chunk.chunkKind,
        start_line: chunk.lineStart,
        end_line: chunk.lineEnd,
        start_byte: chunk.startByte,
        end_byte: chunk.endByte,
        content_hash: chunk.contentHash,
        parser_version: extractorName(),
      },
    });
    ops.push({
      type: 'UpsertEdge',
      id: edgeId(filePath, 'file', chunkName, 'CONTAINS_CHUNK'),
      src: fileNodeId2,
      dst: cid,
      predicate: 'CONTAINS_CHUNK',
      attrs: {},
    });
    if (chunk.name !== null) {
      const symbolKey = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
      const symbolNid = nodeId(filePath, symbolKey);
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(filePath, chunkName, symbolKey, 'DEFINES'),
        src: cid,
        dst: symbolNid,
        predicate: 'DEFINES',
        attrs: {},
      });
    }
  }

  for (let i = 0; i + 1 < chunks.length; i++) {
    const a = chunks[i];
    const b = chunks[i + 1];
    if (a.container == null && b.container == null) {
      const aid = chunkId(filePath, a.chunkKind, a.name, a.lineStart);
      const bid = chunkId(filePath, b.chunkKind, b.name, b.lineStart);
      const aName = a.name ?? `file_body:${a.lineStart}`;
      const bName = b.name ?? `file_body:${b.lineStart}`;
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(filePath, aName, bName, 'NEXT'),
        src: aid,
        dst: bid,
        predicate: 'NEXT',
        attrs: {},
      });
    }
  }

  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    const dstKey = r.predicate === 'CONTAINS'
      ? resolveKey(r.dstName, r.srcName)
      : resolveKey(r.dstName);

    // For cross-file resolved edges (CALLS, EXTENDS), use the defining file's nodeId
    let dstNodeId: string;
    const resolutionKey = `${r.srcName}:${r.predicate}:${r.dstName}`;
    if (edgeResolution.has(resolutionKey)) {
      const { dstFilePath, dstQualifiedKey } = edgeResolution.get(resolutionKey)!;
      dstNodeId = nodeId(dstFilePath, dstQualifiedKey);
    } else {
      dstNodeId = nodeId(filePath, dstKey);
    }

    ops.push({
      type: 'UpsertEdge',
      id: edgeId(filePath, srcKey, dstKey, r.predicate),
      src: nodeId(filePath, srcKey),
      dst: dstNodeId,
      predicate: r.predicate,
      attrs: {},
    });
  }

  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    ops.push({
      type: 'AssertClaim',
      entityId: nodeId(filePath, srcKey),
      field: `${r.predicate.toLowerCase()}:${r.dstName}`,
      value: r.dstName,
      confidence: null,
    });
  }

  const extractor = extractorName();
  const patchId = computePatchId(filePath, sourceHash, extractor);
  const previousPatchId = previousSourceHash
    ? computePatchId(filePath, previousSourceHash, extractor)
    : legacyPatchId(filePath, sourceHash);
  const replaces = [previousPatchId, ...PREVIOUS_EXTRACTORS.map(prev => computePatchId(filePath, sourceHash, prev))];

  return {
    patchId,
    actor: 'ix/ingestion',
    timestamp: new Date().toISOString(),
    source: {
      uri: filePath,
      sourceHash,
      extractor,
      sourceType: sourceType(filePath),
    },
    baseRev: 0,
    ops,
    replaces,
    intent: `Parsed ${nodePath.basename(filePath)}`,
  };
}
