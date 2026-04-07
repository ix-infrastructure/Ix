import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { parseFile, isGrammarSupported, resolveEdges } from './index.js';
import { buildPatchWithResolution } from './patch-builder.js';

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — matches CLI constant
const BULK_BATCH_SIZE = 1000;

const memoryLayerUrl = process.env.IX_MEMORY_LAYER_URL ?? 'http://localhost:8090';
const port = parseInt(process.env.PORT ?? '3000', 10);

// ---------------------------------------------------------------------------
// Types (mirrors ix-cli/src/client/types.ts — kept local to avoid cross-package dep)
// ---------------------------------------------------------------------------

interface IngestFile {
  path: string;
  content: string;
}

interface IngestRequest {
  files: IngestFile[];
  workspaceRoot: string;
  force?: boolean;
}

interface IngestResult {
  filesProcessed: number;
  patchesApplied: number;
  filesSkipped: number;
  entitiesCreated: number;
  latestRev: number;
  skipReasons: {
    unchanged: number;
    emptyFile: number;
    parseError: number;
    tooLarge: number;
  };
}

// ---------------------------------------------------------------------------
// Memory-layer client (minimal — just what the server needs)
// ---------------------------------------------------------------------------

async function getSourceHashes(filePaths: string[]): Promise<Map<string, string>> {
  if (filePaths.length === 0) return new Map();
  try {
    const resp = await fetch(`${memoryLayerUrl}/v1/source-hashes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: filePaths }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return new Map();
    const result = await resp.json() as Record<string, string>;
    return new Map(Object.entries(result));
  } catch {
    return new Map();
  }
}

async function commitBulk(patches: unknown[]): Promise<number> {
  const resp = await fetch(`${memoryLayerUrl}/v1/patches/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patches }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Memory layer commit failed (${resp.status}): ${text}`);
  }
  const result = await resp.json() as { rev: number };
  return result.rev;
}

// ---------------------------------------------------------------------------
// Core ingest handler
// ---------------------------------------------------------------------------

async function handleIngest(req: IngestRequest): Promise<IngestResult> {
  const result: IngestResult = {
    filesProcessed: 0,
    patchesApplied: 0,
    filesSkipped: 0,
    entitiesCreated: 0,
    latestRev: 0,
    skipReasons: { unchanged: 0, emptyFile: 0, parseError: 0, tooLarge: 0 },
  };

  // Filter to supported, non-empty, non-oversized files and compute hashes.
  const eligible: { path: string; content: string; hash: string }[] = [];
  for (const file of req.files) {
    const byteLen = Buffer.byteLength(file.content, 'utf-8');
    if (byteLen === 0) {
      result.filesSkipped++;
      result.skipReasons.emptyFile++;
      continue;
    }
    if (byteLen > MAX_FILE_BYTES) {
      result.filesSkipped++;
      result.skipReasons.tooLarge++;
      continue;
    }
    if (!isGrammarSupported(file.path)) {
      result.filesSkipped++;
      continue;
    }
    const hash = crypto.createHash('sha256').update(file.content).digest('hex');
    eligible.push({ path: file.path, content: file.content, hash });
  }

  if (eligible.length === 0) return result;

  // Skip files whose content hasn't changed (unless force).
  let knownHashes: Map<string, string> = new Map();
  if (!req.force) {
    knownHashes = await getSourceHashes(eligible.map(f => f.path));
  }

  const toProcess = eligible.filter(f => {
    if (req.force) return true;
    if (knownHashes.get(f.path) === f.hash) {
      result.filesSkipped++;
      result.skipReasons.unchanged++;
      return false;
    }
    return true;
  });

  if (toProcess.length === 0) return result;

  // Parse all eligible files.
  type ParsedFile = { parsed: any; hash: string; previousHash: string | undefined };
  const parsedFiles: ParsedFile[] = [];
  for (const f of toProcess) {
    try {
      const parsed = parseFile(f.path, f.content);
      parsedFiles.push({ parsed, hash: f.hash, previousHash: knownHashes.get(f.path) });
    } catch {
      result.filesSkipped++;
      result.skipReasons.parseError++;
    }
  }

  if (parsedFiles.length === 0) return result;

  // Resolve cross-file edges across the full batch.
  const resolvedEdges = resolveEdges(parsedFiles.map(f => f.parsed));
  const edgesByFile = new Map<string, any[]>();
  for (const edge of resolvedEdges) {
    const arr = edgesByFile.get(edge.srcFilePath) ?? [];
    arr.push(edge);
    edgesByFile.set(edge.srcFilePath, arr);
  }

  // Build patches.
  const patches: unknown[] = [];
  for (const { parsed, hash, previousHash } of parsedFiles) {
    try {
      const patch = buildPatchWithResolution(parsed, hash, edgesByFile.get(parsed.filePath) ?? [], previousHash);
      patches.push(patch);
      result.entitiesCreated += (patch.ops as any[]).filter((op: any) => op.type === 'UpsertNode').length;
    } catch {
      result.filesSkipped++;
      result.skipReasons.parseError++;
    }
  }

  // Commit to memory-layer in bulk batches.
  for (let i = 0; i < patches.length; i += BULK_BATCH_SIZE) {
    const batch = patches.slice(i, i + BULK_BATCH_SIZE);
    const rev = await commitBulk(batch);
    if (rev > result.latestRev) result.latestRev = rev;
    result.patchesApplied += batch.length;
  }

  result.filesProcessed = parsedFiles.length;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/ingest') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed: IngestRequest;
      try {
        parsed = JSON.parse(body) as IngestRequest;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      handleIngest(parsed).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`core-ingestion service listening on port ${port}`);
  console.log(`Memory layer: ${memoryLayerUrl}`);
});
