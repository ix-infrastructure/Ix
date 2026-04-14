import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import { resolveWorkspaceRoot } from '../config.js';
import { renderSection, renderKeyValue, renderSuccess, renderWarning, renderError, renderNote } from '../ui.js';
import { dedupeDiscoveredFilePaths, isSupportedSourceFile } from './ingest.js';

// ---------------------------------------------------------------------------
// Ix push — upload path to the cloud pipeline (Repo Splitter service).
//
// Flow:
//   1. Walk the workspace, dedupe, compute sha256 per file
//   2. POST /v1/ingest/begin with the manifest → {jobId, uploads[]}
//   3. For each upload with uploadUrl != null: PUT bytes (with the signed
//      URL's required headers). uploadUrl=null means content is already
//      staged (dedupe hit) — we skip the PUT.
//   4. POST /v1/ingest/:jobId/files in batches once PUTs land
//   5. Unless --detach: POST /v1/ingest/:jobId/done, then poll /status
//      until the job resolves (or timeout).
//   6. Ctrl-C at any stage before /done posts /cancel before exit.
//
// The local-parse path (`ix ingest`) is untouched — push is additive.
// ---------------------------------------------------------------------------

const BATCH_SIZE_DEFAULT = 100;
const UPLOAD_CONCURRENCY_DEFAULT = 8;
const STATUS_POLL_MS = 2_000;
const DEFAULT_DONE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// ext → canonical language name. Mirrors core-ingestion's EXT_MAP closely
// enough for the server to pick the right extractor; the server re-derives
// this anyway, so false positives here just round-trip through parse.files.
const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.go': 'go',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.php': 'php',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala', '.sc': 'scala',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.sql': 'sql',
  '.json': 'json',
  '.toml': 'toml',
  '.md': 'markdown', '.markdown': 'markdown',
};

function languageFor(filePath: string): string {
  const base = nodePath.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile';
  return EXT_LANG[nodePath.extname(filePath).toLowerCase()] ?? 'text';
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', 'out', '.next',
  '__pycache__', '.tox', '.venv', 'venv',
  '.idea', '.vscode', '.cache', 'coverage', '.nyc_output',
  'vendor', 'Pods',
  'bin', 'obj', 'pkg',
  '.ix', '.claude',
]);

const GENERATED_SUFFIXES = ['.pb.go', '_deepcopy.go', '_mock.go', '.pb.ts', '.pb.js', '_pb.ts', '_pb.js'];
const GENERATED_PREFIXES = ['zz_generated', 'mock_'];

function isGenerated(basename: string): boolean {
  return (
    GENERATED_SUFFIXES.some(s => basename.endsWith(s)) ||
    GENERATED_PREFIXES.some(p => basename.startsWith(p))
  );
}

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('.') && entry.name !== '.') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile() && isSupportedSourceFile(entry.name) && !isGenerated(entry.name)) {
      yield full;
    }
  }
}

function tryGitLsFiles(dir: string): string[] | null {
  try {
    const result = spawnSync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: dir, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    const files: string[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const full = nodePath.resolve(dir, line);
      if (!isSupportedSourceFile(full)) continue;
      if (isGenerated(nodePath.basename(full))) continue;
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
      files.push(full);
    }
    return files;
  } catch {
    return null;
  }
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Git metadata
// ---------------------------------------------------------------------------

function detectCommitSha(dir: string): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function detectRepoName(dir: string): string | null {
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: dir, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  // Pull "owner/repo" out of URLs like git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Auth: Cloud Run requires a Google ID token for ingress.
//   IX_PUSH_TOKEN (if set) wins; otherwise shell out to gcloud.
// ---------------------------------------------------------------------------

function resolveAuthToken(audience: string): string {
  const env = process.env.IX_PUSH_TOKEN;
  if (env && env.length > 0) return env;
  const r = spawnSync(
    'gcloud',
    ['auth', 'print-identity-token', `--audiences=${audience}`],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    throw new Error(
      'Could not obtain a Google ID token. Set IX_PUSH_TOKEN, or install gcloud and run `gcloud auth login`.',
    );
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// HTTP shapes (mirror Repo Splitter routes)
// ---------------------------------------------------------------------------

interface BeginUpload {
  path: string;
  sha256: string;
  language: string;
  byteSize: number;
  gsUri: string;
  uploadUrl: string | null;
  method: 'PUT';
  headers: Record<string, string>;
}

interface BeginResponse {
  jobId: string;
  state: string;
  idempotent: boolean;
  uploads: BeginUpload[];
}

interface StatusResponse {
  jobId: string;
  state: 'pending' | 'uploading' | 'done' | 'cancelled';
  expectedFileCount: number;
  filesPublished: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpJson<T>(
  url: string,
  method: 'GET' | 'POST',
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function putSigned(upload: BeginUpload, bytes: Buffer): Promise<void> {
  if (!upload.uploadUrl) return;
  // Node's fetch handles Buffer at runtime, but @types/node's
  // ArrayBufferLike (which allows SharedArrayBuffer) doesn't unify
  // with lib.dom's strict ArrayBuffer in BodyInit. Cast through
  // ArrayBufferView — the runtime contract is sound.
  const body = bytes as unknown as BodyInit;
  const res = await fetch(upload.uploadUrl, {
    method: 'PUT',
    headers: upload.headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT ${upload.path} failed: ${res.status} ${res.statusText} ${text}`);
  }
}

// Simple concurrency-limited Promise.all. Rejects on first error.
async function mapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

interface PushOptions {
  root?: string;
  endpoint?: string;
  org?: string;
  repo?: string;
  commitSha?: string;
  mode: 'INITIAL' | 'INCREMENTAL';
  idempotencyKey?: string;
  detach: boolean;
  batchSize: string;
  concurrency: string;
  timeout: string;
  token?: string;
}

export function registerPushCommand(program: Command): void {
  program
    .command('push [dir]')
    .description('Upload the repo to the Ix cloud pipeline for server-side parsing')
    .option('--endpoint <url>', 'Repo Splitter base URL (or IX_PUSH_ENDPOINT)')
    .option('--org <id>', 'Org id (or IX_ORG_ID)')
    .option('--repo <name>', 'Repo identifier (defaults to git remote)')
    .option('--commit-sha <sha>', 'Commit sha (defaults to git HEAD)')
    .option('--mode <mode>', 'INITIAL or INCREMENTAL', 'INCREMENTAL')
    .option('--idempotency-key <key>', 'Idempotency key (default: repo@commitSha)')
    .option('--detach', 'Return after /done without waiting for server-side parse', false)
    .option('--batch-size <n>', 'Files per /files POST', String(BATCH_SIZE_DEFAULT))
    .option('--concurrency <n>', 'Parallel uploads', String(UPLOAD_CONCURRENCY_DEFAULT))
    .option('--timeout <ms>', 'Block up to this long for job to finish', String(DEFAULT_DONE_TIMEOUT_MS))
    .option('--token <jwt>', 'Google ID token (else IX_PUSH_TOKEN or gcloud)')
    .option('--root <dir>', 'Workspace root')
    .action(async (dirArg: string | undefined, opts: PushOptions) => {
      try {
        await runPush(dirArg, opts);
      } catch (err) {
        renderError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function runPush(dirArg: string | undefined, opts: PushOptions): Promise<void> {
  const root = dirArg
    ? nodePath.resolve(dirArg)
    : resolveWorkspaceRoot(opts.root);

  const endpoint = opts.endpoint ?? process.env.IX_PUSH_ENDPOINT;
  if (!endpoint) {
    throw new Error('Endpoint is required. Pass --endpoint or set IX_PUSH_ENDPOINT.');
  }
  const orgId = opts.org ?? process.env.IX_ORG_ID;
  if (!orgId) {
    throw new Error('Org id is required. Pass --org or set IX_ORG_ID.');
  }

  const commitSha = opts.commitSha ?? detectCommitSha(root);
  if (!commitSha) {
    throw new Error('Could not detect git commit sha. Pass --commit-sha or run inside a git repo.');
  }
  const repo = opts.repo ?? detectRepoName(root);
  if (!repo) {
    throw new Error('Could not detect repo name. Pass --repo or configure remote.origin.url.');
  }
  const idempotencyKey = opts.idempotencyKey ?? `${repo}@${commitSha}`;

  const token = opts.token ?? resolveAuthToken(endpoint);

  // 1. Discover files.
  renderSection('Discovering files');
  const discovered = tryGitLsFiles(root) ?? Array.from(walkFiles(root));
  const deduped = dedupeDiscoveredFilePaths(discovered);
  if (deduped.length === 0) {
    renderWarning('No supported source files found.');
    return;
  }
  renderKeyValue('Root', root);
  renderKeyValue('Files', String(deduped.length));

  // 2. Hash + build manifest.
  renderSection('Hashing');
  const manifest = await buildManifest(deduped, root);

  // 3. /begin
  renderSection('Beginning ingest');
  renderKeyValue('Endpoint', endpoint);
  renderKeyValue('Org', orgId);
  renderKeyValue('Repo', repo);
  renderKeyValue('Commit', commitSha);
  renderKeyValue('Mode', opts.mode);
  renderKeyValue('Idempotency', idempotencyKey);

  const begin = await httpJson<BeginResponse>(
    `${endpoint}/v1/ingest/begin`,
    'POST',
    token,
    {
      orgId,
      repo,
      commitSha,
      mode: opts.mode,
      idempotencyKey,
      files: manifest,
    },
  );
  renderKeyValue('Job id', begin.jobId);
  if (begin.idempotent) renderNote('Idempotent replay — reusing existing job.');

  // Install cancel handler from this point forward.
  const cancelGuard = installCancelHandler(endpoint, begin.jobId, token);

  try {
    // 4. Upload the files that need it.
    await uploadFiles(begin, root, parseIntOption(opts.concurrency, UPLOAD_CONCURRENCY_DEFAULT));

    // 5. Publish /files in batches so the server can start parsing while
    //    the CLI is still uploading the tail of the repo. For a first
    //    cut we publish after all uploads land — streaming-as-we-go is
    //    a straightforward follow-up.
    await publishFilesBatches(
      endpoint,
      token,
      begin.jobId,
      begin.uploads,
      parseIntOption(opts.batchSize, BATCH_SIZE_DEFAULT),
    );

    // 6. /done
    if (opts.detach) {
      renderSection('Uploads complete');
      renderNote(`Detached. Poll with: ix push status ${begin.jobId}`);
      renderKeyValue('Job id', begin.jobId);
      cancelGuard.disarm();
      return;
    }

    renderSection('Finalizing');
    await httpJson<{ state: string }>(
      `${endpoint}/v1/ingest/${begin.jobId}/done`,
      'POST',
      token,
    );
    // Past /done, /cancel is a no-op server-side but there's nothing
    // worth cancelling anymore — disarm the handler.
    cancelGuard.disarm();

    // Polling /status reports only the Repo Splitter's view (it flips to
    // "done" when /done is posted). Downstream Parse Worker / Edge
    // Resolver completion isn't surfaced here yet. Ship a minimal
    // pass-through and expand once the status endpoint aggregates.
    await pollForDone(
      endpoint,
      token,
      begin.jobId,
      parseIntOption(opts.timeout, DEFAULT_DONE_TIMEOUT_MS),
    );

    renderSection('Done');
    renderSuccess(`Job ${begin.jobId} complete.`);
  } catch (err) {
    // Fall through to the cancel handler's finally — rethrow so the
    // outer handler renders the error and exits 1.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ManifestEntry {
  path: string;           // POSIX, repo-relative
  sha256: string;
  byteSize: number;
  language: string;
  absPath: string;        // kept locally for the upload step
}

async function buildManifest(
  absolutePaths: string[],
  root: string,
): Promise<Array<Omit<ManifestEntry, 'absPath'>>> {
  // Hashing is IO-bound; serial is fine at this scale and keeps error
  // handling simple. Revisit if repos > 50k files become common.
  const out: ManifestEntry[] = [];
  let printedAt = 0;
  for (let i = 0; i < absolutePaths.length; i++) {
    const abs = absolutePaths[i];
    let bytes: Buffer;
    try { bytes = fs.readFileSync(abs); } catch { continue; }
    const rel = nodePath.relative(root, abs).split(nodePath.sep).join('/');
    out.push({
      path: rel,
      absPath: abs,
      sha256: sha256Hex(bytes),
      byteSize: bytes.length,
      language: languageFor(abs),
    });
    if (Date.now() - printedAt > 1000) {
      process.stderr.write(chalk.dim(`\r  hashing ${i + 1}/${absolutePaths.length}`));
      printedAt = Date.now();
    }
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  // Stash the absPath map on a side channel so uploadFiles can find it
  // again without re-hashing.
  manifestAbsPathIndex.clear();
  for (const m of out) manifestAbsPathIndex.set(m.sha256, m.absPath);
  return out.map(({ absPath: _ignore, ...rest }) => rest);
}

const manifestAbsPathIndex = new Map<string, string>();

async function uploadFiles(
  begin: BeginResponse,
  _root: string,
  concurrency: number,
): Promise<void> {
  const needsUpload = begin.uploads.filter(u => u.uploadUrl !== null);
  const skipped = begin.uploads.length - needsUpload.length;

  renderSection('Uploading');
  renderKeyValue('To upload', String(needsUpload.length));
  if (skipped > 0) renderKeyValue('Deduped', String(skipped));

  let done = 0;
  let printedAt = 0;
  await mapLimit(needsUpload, concurrency, async (upload) => {
    const abs = manifestAbsPathIndex.get(upload.sha256);
    if (!abs) throw new Error(`manifest missing abs path for sha ${upload.sha256}`);
    const bytes = fs.readFileSync(abs);
    await putSigned(upload, bytes);
    done++;
    if (Date.now() - printedAt > 500) {
      process.stderr.write(chalk.dim(`\r  uploaded ${done}/${needsUpload.length}`));
      printedAt = Date.now();
    }
  });
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  renderSuccess(`${needsUpload.length} uploaded, ${skipped} deduped.`);
}

async function publishFilesBatches(
  endpoint: string,
  token: string,
  jobId: string,
  uploads: BeginUpload[],
  batchSize: number,
): Promise<void> {
  renderSection('Publishing manifest');
  const batches = chunk(uploads, batchSize);
  let published = 0;
  for (const batch of batches) {
    const res = await httpJson<{ published: number }>(
      `${endpoint}/v1/ingest/${jobId}/files`,
      'POST',
      token,
      {
        files: batch.map(b => ({
          path: b.path,
          sha256: b.sha256,
          byteSize: b.byteSize,
          language: b.language,
        })),
      },
    );
    published += res.published;
    process.stderr.write(chalk.dim(`\r  published ${published}/${uploads.length}`));
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');
  renderSuccess(`${published} files queued for parsing.`);
}

async function pollForDone(
  endpoint: string,
  token: string,
  jobId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await httpJson<StatusResponse>(
      `${endpoint}/v1/ingest/${jobId}/status`,
      'GET',
      token,
    );
    process.stderr.write(
      chalk.dim(`\r  state=${status.state} published=${status.filesPublished}/${status.expectedFileCount}`),
    );
    if (status.state === 'done' || status.state === 'cancelled') {
      process.stderr.write('\r' + ' '.repeat(60) + '\r');
      if (status.state === 'cancelled') throw new Error('job was cancelled');
      return;
    }
    await new Promise<void>(r => setTimeout(r, STATUS_POLL_MS));
  }
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  throw new Error(`timed out after ${timeoutMs}ms waiting for job to finish`);
}

// ---------------------------------------------------------------------------
// Ctrl-C handler: post /cancel once. Disarmable once we're past /done.
// ---------------------------------------------------------------------------

function installCancelHandler(endpoint: string, jobId: string, token: string) {
  let armed = true;
  const onSignal = async (signal: string) => {
    if (!armed) return;
    armed = false;
    process.stderr.write('\n');
    renderWarning(`${signal} received — cancelling job ${jobId}`);
    try {
      await httpJson(`${endpoint}/v1/ingest/${jobId}/cancel`, 'POST', token);
      renderSuccess('Cancel posted.');
    } catch (err) {
      renderError(`Cancel request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(130);
  };
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  return {
    disarm: () => { armed = false; },
  };
}

function parseIntOption(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
