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

/**
 * Identity helpers bound to a single workspace. Folding `workspaceId` into every
 * id keeps the same relative path in two different workspaces from colliding on
 * a shared backend, while staying stable within a workspace. Binding it once via
 * a factory means every call site below is scoped automatically (no per-call
 * threading to forget). `workspaceId` is empty only for callers that have not
 * adopted workspace-scoped identity yet.
 */
function makeIds(workspaceId: string) {
  const ns = workspaceId ? `${workspaceId}:` : '';
  return {
    nodeId: (filePath: string, name: string): string =>
      deterministicId(`${ns}${normalizePath(filePath)}:${name}`),

    edgeId: (filePath: string, src: string, dst: string, predicate: string): string =>
      deterministicId(`${ns}${normalizePath(filePath)}:${src}:${dst}:${predicate}`),

    // Chunk id is keyed on file + kind + name + start line to survive minor edits.
    chunkId: (filePath: string, chunkKind: string, name: string | null, startLine: number): string =>
      deterministicId(`${ns}${normalizePath(filePath)}:chunk:${chunkKind}:${name ?? 'file_body'}:${startLine}`),

    // patchId for a (filePath, sourceHash, extractorVersion) triple.
    computePatchId: (filePath: string, sourceHash: string, extractor: string): string =>
      deterministicId(`${ns}${normalizePath(filePath)}:${sourceHash}:${extractor}`),

    // Legacy patchId (pre-1.1 scheme, no extractor suffix).
    legacyPatchId: (filePath: string, sourceHash: string): string =>
      deterministicId(`${ns}${filePath}:${sourceHash}`),
  };
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
  return `tree-sitter/1.24`;
}

/** Previous extractor versions — their patches are superseded when re-ingesting. */
export const PREVIOUS_EXTRACTORS = ['tree-sitter/1.23', 'tree-sitter/1.22', 'tree-sitter/1.21', 'tree-sitter/1.20', 'tree-sitter/1.19', 'tree-sitter/1.18', 'tree-sitter/1.17', 'tree-sitter/1.16', 'tree-sitter/1.15', 'tree-sitter/1.14', 'tree-sitter/1.13', 'tree-sitter/1.12', 'tree-sitter/1.11', 'tree-sitter/1.10', 'tree-sitter/1.9', 'tree-sitter/1.8', 'tree-sitter/1.7', 'tree-sitter/1.6', 'tree-sitter/1.5', 'tree-sitter/1.4', 'tree-sitter/1.3', 'tree-sitter/1.2', 'tree-sitter/1.1'];

// nodeId / edgeId / chunkId / computePatchId / legacyPatchId are produced by
// makeIds(workspaceId) above so every id is scoped to its workspace.

/**
 * In a multi-repo co-ingest, file paths are workspace-relative AND repo-prefixed:
 * the first path segment is the member repo directory (see `repoOf` in the CLI).
 * Node / edge / chunk IDENTITY is folded over the MEMBER-relative path (that prefix
 * stripped) paired with the member's own workspace_id, so a repo's ids are
 * byte-identical whether it is ingested alone or as part of a system. PROVENANCE
 * (source_uri / file_uri / patch id) deliberately keeps the full workspace-relative
 * path so reads can reconstruct an absolute path under the workspace root. Edge
 * *matching* (resolvedEdges keyed on srcFilePath) also uses the full path, and
 * repoWorkspaceOf is given the full path to identify the owning repo. Single-repo
 * ingest (no multiRepo) is unchanged (idPath === filePath).
 */
function toMemberRelativePath(filePath: string, multiRepo?: MultiRepoContext): string {
  if (!multiRepo) return filePath;
  const norm = filePath.replace(/\\/g, '/');
  const slash = norm.indexOf('/');
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

// ---------------------------------------------------------------------------
// Build a GraphPatchPayload from a FileParseResult
// ---------------------------------------------------------------------------

export function buildPatch(
  result: FileParseResult,
  sourceHash: string,
  workspaceId: string,
  previousSourceHash?: string,
  multiRepo?: MultiRepoContext,
): GraphPatchPayload {
  const { entities, chunks, relationships } = result;
  // Two paths, deliberately distinct (see toMemberRelativePath):
  //  - filePath (workspace-relative, repo-prefixed in a co-ingest) is PROVENANCE:
  //    source_uri / file_uri / patch id. Reads reconstruct an absolute path by
  //    joining it to the workspace root, so it must stay relative to that root.
  //  - idPath (member-relative) is IDENTITY: node / edge / chunk ids fold it so a
  //    member's ids are byte-identical whether ingested alone or in a system.
  // Single repo: idPath === filePath.
  const filePath = result.filePath;
  const idPath = toMemberRelativePath(result.filePath, multiRepo);
  const { nodeId, edgeId, chunkId, computePatchId, legacyPatchId } = makeIds(workspaceId);
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

  // Set of all qualified keys defined in this file — used to distinguish same-file
  // dotted calls (e.g. "Foo.bar" where Foo is defined here) from external qualified
  // calls (e.g. "dplyr.filter" from R's pkg::func syntax) that would produce phantoms.
  const allQKeys = new Set<string>(entityQKey.values());

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
    const id = nodeId(idPath, qk);
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
  const fileNodeId = nodeId(idPath, entities.find(e => e.kind === 'file')?.name ?? idPath);
  for (const chunk of chunks) {
    const cid = chunkId(idPath, chunk.chunkKind, chunk.name, chunk.lineStart);
    const chunkName = chunk.name ?? `file_body:${chunk.lineStart}`;
    const chunkNodeKind = chunk.chunkKind === 'section' ? 'section' : 'chunk';
    ops.push({
      type: 'UpsertNode',
      id: cid,
      kind: chunkNodeKind,
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
      id: edgeId(idPath, 'file', chunkName, 'CONTAINS_CHUNK'),
      src: fileNodeId,
      dst: cid,
      predicate: 'CONTAINS_CHUNK',
      attrs: {},
    });
    // Chunk -[DEFINES]-> Symbol (only for named chunks)
    if (chunk.name !== null) {
      const symbolKey = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
      const symbolNid = nodeId(idPath, symbolKey);
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(idPath, chunkName, symbolKey, 'DEFINES'),
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
      const aid = chunkId(idPath, a.chunkKind, a.name, a.lineStart);
      const bid = chunkId(idPath, b.chunkKind, b.name, b.lineStart);
      const aName = a.name ?? `file_body:${a.lineStart}`;
      const bName = b.name ?? `file_body:${b.lineStart}`;
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(idPath, aName, bName, 'NEXT'),
        src: aid,
        dst: bid,
        predicate: 'NEXT',
        attrs: {},
      });
    }
  }

  // UpsertEdge for each relationship
  const seenExternalNodes = new Set<string>();
  for (const r of relationships) {
    // For CONTAINS edges, srcName is the container of dstName — use that to disambiguate.
    const srcKey = resolveKey(r.srcName);
    const dstKey = r.predicate === 'CONTAINS'
      ? resolveKey(r.dstName, r.srcName)
      : resolveKey(r.dstName);

    let dstNid: string;
    if (r.predicate === 'CALLS' && dstKey.includes('::') && !allQKeys.has(dstKey)) {
      const sep = dstKey.indexOf('::');
      const pkgName = dstKey.slice(0, sep);
      const funcName = dstKey.slice(sep + 2);
      const extPath = `external://${pkgName}`;
      dstNid = nodeId(extPath, dstKey);
      if (!seenExternalNodes.has(dstNid)) {
        seenExternalNodes.add(dstNid);
        ops.push({
          type: 'UpsertNode',
          id: dstNid,
          kind: 'function',
          name: funcName,
          attrs: { package: pkgName, external: true, language: result.language },
        });
      }
    } else {
      dstNid = nodeId(idPath, dstKey);
    }

    ops.push({
      type: 'UpsertEdge',
      id: edgeId(idPath, srcKey, dstKey, r.predicate),
      src: nodeId(idPath, srcKey),
      dst: dstNid,
      predicate: r.predicate,
      attrs: {},
    });
  }

  // AssertClaim for each relationship (feeds the confidence/conflict engine)
  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    ops.push({
      type: 'AssertClaim',
      entityId: nodeId(idPath, srcKey),
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
      workspaceId,
      ...(multiRepo?.systemId ? { systemId: multiRepo.systemId } : {}),
      ...(multiRepo?.repoId ? { repoId: multiRepo.repoId } : {}),
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

/**
 * Multi-repo co-ingest context (Ix#225 Path 1). When several repos are ingested
 * as one system, each repo keeps its OWN workspace_id (so a repo's node ids are
 * stable whether ingested alone or in a system), all share a systemId, and each
 * file carries its repoId. A cross-repo resolved edge's dst node lives in another
 * repo whose ids are folded with ITS workspace_id, so dst ids must be resolved in
 * that repo's namespace via repoWorkspaceOf. Absent => single-repo, unchanged.
 */
export interface MultiRepoContext {
  systemId?: string;
  repoId?: string;
  /** filePath (workspace-relative, repo-prefixed) -> that file's repo workspace_id. */
  repoWorkspaceOf?: (filePath: string) => string | undefined;
}

export function buildPatchWithResolution(
  result: FileParseResult,
  sourceHash: string,
  workspaceId: string,
  resolvedEdges: ResolvedEdge[],
  previousSourceHash?: string,
  multiRepo?: MultiRepoContext,
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

  const { entities, chunks, relationships } = result;
  // filePath = workspace-relative PROVENANCE (source_uri / file_uri / patch id);
  // idPath = member-relative IDENTITY (node / edge / chunk ids) so a member's ids are
  // byte-identical solo vs. co-ingested. Edge matching still keys on the full
  // result.filePath above. Single-repo: idPath === filePath.
  const filePath = result.filePath;
  const idPath = toMemberRelativePath(result.filePath, multiRepo);
  const { nodeId, edgeId, chunkId, computePatchId, legacyPatchId } = makeIds(workspaceId);
  // Resolve a dst node id in the namespace of the repo that OWNS dstFilePath.
  // For same-repo (or single-repo) dsts this is just nodeId; for a cross-repo
  // edge it folds with the dst repo's workspace_id so the id matches the node
  // that repo's own ingest produced. repoWorkspaceOf needs the full (repo-prefixed)
  // dstFilePath to find the owning repo; the id itself uses the member-relative path.
  const crossRepoIdsCache = new Map<string, ReturnType<typeof makeIds>>();
  const dstNodeIdInRepo = (dstFilePath: string, key: string): string => {
    const ws = multiRepo?.repoWorkspaceOf?.(dstFilePath);
    const dstIdPath = toMemberRelativePath(dstFilePath, multiRepo);
    if (!ws || ws === workspaceId) return nodeId(dstIdPath, key);
    let ids = crossRepoIdsCache.get(ws);
    if (!ids) { ids = makeIds(ws); crossRepoIdsCache.set(ws, ids); }
    return ids.nodeId(dstIdPath, key);
  };
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

  const allQKeys2 = new Set<string>(entityQKey.values());

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
    const id = nodeId(idPath, qk);
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
  const fileNodeId2 = nodeId(idPath, entities.find(e => e.kind === 'file')?.name ?? idPath);
  for (const chunk of chunks) {
    const cid = chunkId(idPath, chunk.chunkKind, chunk.name, chunk.lineStart);
    const chunkName = chunk.name ?? `file_body:${chunk.lineStart}`;
    const chunkNodeKind2 = chunk.chunkKind === 'section' ? 'section' : 'chunk';
    ops.push({
      type: 'UpsertNode',
      id: cid,
      kind: chunkNodeKind2,
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
      id: edgeId(idPath, 'file', chunkName, 'CONTAINS_CHUNK'),
      src: fileNodeId2,
      dst: cid,
      predicate: 'CONTAINS_CHUNK',
      attrs: {},
    });
    if (chunk.name !== null) {
      const symbolKey = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
      const symbolNid = nodeId(idPath, symbolKey);
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(idPath, chunkName, symbolKey, 'DEFINES'),
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
      const aid = chunkId(idPath, a.chunkKind, a.name, a.lineStart);
      const bid = chunkId(idPath, b.chunkKind, b.name, b.lineStart);
      const aName = a.name ?? `file_body:${a.lineStart}`;
      const bName = b.name ?? `file_body:${b.lineStart}`;
      ops.push({
        type: 'UpsertEdge',
        id: edgeId(idPath, aName, bName, 'NEXT'),
        src: aid,
        dst: bid,
        predicate: 'NEXT',
        attrs: {},
      });
    }
  }

  const seenExternalNodes2 = new Set<string>();
  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    const dstKey = r.predicate === 'CONTAINS'
      ? resolveKey(r.dstName, r.srcName)
      : resolveKey(r.dstName);

    let dstNodeId: string;
    const resolutionKey = `${r.srcName}:${r.predicate}:${r.dstName}`;

    if (edgeResolution.has(resolutionKey)) {
      // Cross-file resolved — use the defining file's nodeId, in the dst repo's
      // workspace namespace (matters only for cross-repo edges in a co-ingest).
      const { dstFilePath, dstQualifiedKey } = edgeResolution.get(resolutionKey)!;
      dstNodeId = dstNodeIdInRepo(dstFilePath, dstQualifiedKey);
    } else if (r.predicate === 'CALLS' && dstKey.includes('::') && !allQKeys2.has(dstKey)) {
      const sep = dstKey.indexOf('::');
      const pkgName = dstKey.slice(0, sep);
      const funcName = dstKey.slice(sep + 2);
      const extPath = `external://${pkgName}`;
      dstNodeId = nodeId(extPath, dstKey);
      if (!seenExternalNodes2.has(dstNodeId)) {
        seenExternalNodes2.add(dstNodeId);
        ops.push({
          type: 'UpsertNode',
          id: dstNodeId,
          kind: 'function',
          name: funcName,
          attrs: { package: pkgName, external: true, language: result.language },
        });
      }
    } else {
      dstNodeId = nodeId(idPath, dstKey);
    }

    ops.push({
      type: 'UpsertEdge',
      id: edgeId(idPath, srcKey, dstKey, r.predicate),
      src: nodeId(idPath, srcKey),
      dst: dstNodeId,
      predicate: r.predicate,
      attrs: {},
    });
  }

  for (const r of relationships) {
    const srcKey = resolveKey(r.srcName);
    ops.push({
      type: 'AssertClaim',
      entityId: nodeId(idPath, srcKey),
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
      workspaceId,
      ...(multiRepo?.systemId ? { systemId: multiRepo.systemId } : {}),
      ...(multiRepo?.repoId ? { repoId: multiRepo.repoId } : {}),
    },
    baseRev: 0,
    ops,
    replaces,
    intent: `Parsed ${nodePath.basename(filePath)}`,
  };
}
