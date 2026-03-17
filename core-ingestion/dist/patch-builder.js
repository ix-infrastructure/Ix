import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
// ---------------------------------------------------------------------------
// Deterministic UUID from a string (matches existing CLI convention)
// ---------------------------------------------------------------------------
function deterministicId(input) {
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join('-');
}
function nodeId(filePath, name) {
    return deterministicId(`${filePath}:${name}`);
}
function edgeId(filePath, src, dst, predicate) {
    return deterministicId(`${filePath}:${src}:${dst}:${predicate}`);
}
// ---------------------------------------------------------------------------
// Source type from file extension
// ---------------------------------------------------------------------------
function sourceType(filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'].includes(ext))
        return 'config';
    if (['.md', '.mdx', '.rst', '.txt'].includes(ext))
        return 'doc';
    return 'code';
}
export function extractorName() {
    return `tree-sitter/1.11`;
}
/** Previous extractor versions — their patches are superseded when re-ingesting. */
export const PREVIOUS_EXTRACTORS = ['tree-sitter/1.10', 'tree-sitter/1.9', 'tree-sitter/1.8', 'tree-sitter/1.7', 'tree-sitter/1.6', 'tree-sitter/1.5', 'tree-sitter/1.4', 'tree-sitter/1.3', 'tree-sitter/1.2', 'tree-sitter/1.1'];
/** Compute a patchId for a (filePath, sourceHash, extractorVersion) triple. */
function computePatchId(filePath, sourceHash, extractor) {
    return deterministicId(`${filePath}:${sourceHash}:${extractor}`);
}
/** Compute the legacy patchId (pre-1.1 scheme, no extractor suffix). */
function legacyPatchId(filePath, sourceHash) {
    return deterministicId(`${filePath}:${sourceHash}`);
}
// ---------------------------------------------------------------------------
// Build a GraphPatchPayload from a FileParseResult
// ---------------------------------------------------------------------------
export function buildPatch(result, sourceHash, previousSourceHash) {
    const { filePath, entities, relationships } = result;
    const ops = [];
    // Build a qualified-key map so that same-named entities in different
    // enclosing classes within the same file get distinct nodeIds.
    // e.g.  ClassA.update  vs  ClassB.update  instead of both being "update".
    const entityQKey = new Map();
    for (const e of entities) {
        entityQKey.set(e, e.container ? `${e.container}.${e.name}` : e.name);
    }
    // Reverse lookup: plain name → list of qualified keys (for edge resolution).
    const nameToQKeys = new Map();
    for (const [e, qk] of entityQKey) {
        const list = nameToQKeys.get(e.name) ?? [];
        list.push(qk);
        nameToQKeys.set(e.name, list);
    }
    // Resolve a relationship endpoint to the best qualified key.
    // For unambiguous names (appear once), returns the single qualified key.
    // For ambiguous names (appear multiple times), falls back to the plain name
    // so that the edge still points to *something* deterministic.
    function resolveKey(name, container) {
        const keys = nameToQKeys.get(name);
        if (!keys || keys.length === 1)
            return keys?.[0] ?? name;
        // More than one entity with this name — try to pick by container
        if (container) {
            const qualified = `${container}.${name}`;
            if (keys.includes(qualified))
                return qualified;
        }
        // Ambiguous: return plain name so we don't silently drop the edge
        return name;
    }
    // UpsertNode for each entity (deduplicated by id — last occurrence wins)
    const seenNodeIds = new Set();
    for (const e of entities) {
        const qk = entityQKey.get(e);
        const id = nodeId(filePath, qk);
        if (!seenNodeIds.has(id)) {
            seenNodeIds.add(id);
            ops.push({
                type: 'UpsertNode',
                id,
                kind: e.kind,
                name: e.name,
                attrs: {
                    line_start: e.lineStart,
                    line_end: e.lineEnd,
                    language: e.language,
                },
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
export function buildPatchWithResolution(result, sourceHash, resolvedEdges, previousSourceHash) {
    // Build lookup: `${predicate}:${dstName}` → { dstFilePath, dstQualifiedKey }
    const edgeResolution = new Map();
    for (const edge of resolvedEdges) {
        if (edge.srcFilePath === result.filePath) {
            edgeResolution.set(`${edge.predicate}:${edge.dstName}`, {
                dstFilePath: edge.dstFilePath,
                dstQualifiedKey: edge.dstQualifiedKey,
            });
        }
    }
    const { filePath, entities, relationships } = result;
    const ops = [];
    const entityQKey = new Map();
    for (const e of entities) {
        entityQKey.set(e, e.container ? `${e.container}.${e.name}` : e.name);
    }
    const nameToQKeys = new Map();
    for (const [e, qk] of entityQKey) {
        const list = nameToQKeys.get(e.name) ?? [];
        list.push(qk);
        nameToQKeys.set(e.name, list);
    }
    function resolveKey(name, container) {
        const keys = nameToQKeys.get(name);
        if (!keys || keys.length === 1)
            return keys?.[0] ?? name;
        if (container) {
            const qualified = `${container}.${name}`;
            if (keys.includes(qualified))
                return qualified;
        }
        return name;
    }
    const seenNodeIds2 = new Set();
    for (const e of entities) {
        const qk = entityQKey.get(e);
        const id = nodeId(filePath, qk);
        if (!seenNodeIds2.has(id)) {
            seenNodeIds2.add(id);
            ops.push({
                type: 'UpsertNode',
                id,
                kind: e.kind,
                name: e.name,
                attrs: { line_start: e.lineStart, line_end: e.lineEnd, language: e.language },
            });
        }
    }
    for (const r of relationships) {
        const srcKey = resolveKey(r.srcName);
        const dstKey = r.predicate === 'CONTAINS'
            ? resolveKey(r.dstName, r.srcName)
            : resolveKey(r.dstName);
        // For cross-file resolved edges (CALLS, EXTENDS), use the defining file's nodeId
        let dstNodeId;
        const resolutionKey = `${r.predicate}:${r.dstName}`;
        if (edgeResolution.has(resolutionKey)) {
            const { dstFilePath, dstQualifiedKey } = edgeResolution.get(resolutionKey);
            dstNodeId = nodeId(dstFilePath, dstQualifiedKey);
        }
        else {
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
