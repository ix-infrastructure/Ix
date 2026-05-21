// Remote ingestion runner — drives the cloud pipeline via the repo-splitter
// HTTP API. Flow: discover files → hash → POST /begin → PUT to GCS via
// signed URLs → POST /files → POST /done.
//
// This replaces the local tree-sitter parse path when the backend advertises
// a repoSplitterEndpoint via /v1/capabilities.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as nodePath from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { RemoteRunner, RemoteIngestOptions } from "./remote.js";
import { getAuthToken, refreshAuthIfNeeded } from "./config.js";

// ---------------------------------------------------------------------------
// Extension → language map (lightweight, no tree-sitter dependency)
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".rb": "ruby",
  ".rs": "rust",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sc": "scala",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".json": "json",
  ".toml": "toml",
  ".md": "markdown",
  ".markdown": "markdown",
  // Text / document types — routed to the text pipeline for semantic extraction
  ".txt": "text",
  ".text": "text",
  ".log": "text",
  ".pdf": "pdf",
  ".rst": "rst",
  ".tex": "tex",
  ".latex": "tex",
  ".adoc": "asciidoc",
  ".asciidoc": "asciidoc",
  ".org": "org",
  ".rtf": "rtf",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".csv": "csv",
  ".tsv": "csv",
};

function languageFromPath(filePath: string): string | null {
  const base = nodePath.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  return EXT_TO_LANGUAGE[nodePath.extname(filePath).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// File discovery (mirrors ingest.ts but lightweight — no tree-sitter)
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXT_TO_LANGUAGE));

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "target", "out", ".next",
  "__pycache__", ".tox", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  ".gradle", ".idea", ".vscode", ".settings", ".vs",
  ".cache", ".parcel-cache", "coverage", ".nyc_output",
  "vendor", "Pods", ".dart_tool", ".pub-cache",
  "bin", "obj", "pkg",
  ".ix", ".claude", ".gitnexus",
  "test", "tests", "__tests__", "spec", "specs", "e2e",
  "examples", "fixtures", "__mocks__", "__fixtures__",
]);

const GENERATED_FILE_SUFFIXES = [
  ".pb.go", "_deepcopy.go", "_mock.go",
  ".pb.ts", ".pb.js", "_pb.ts", "_pb.js",
];

const GENERATED_FILE_PREFIXES = ["zz_generated", "mock_"];

function isSupportedFile(filePath: string): boolean {
  const base = nodePath.basename(filePath).toLowerCase();
  return base === "dockerfile"
    || base.endsWith(".dockerfile")
    || SUPPORTED_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());
}

function isGeneratedFile(basename: string): boolean {
  for (const s of GENERATED_FILE_SUFFIXES) if (basename.endsWith(s)) return true;
  for (const p of GENERATED_FILE_PREFIXES) if (basename.startsWith(p)) return true;
  return false;
}

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".") continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      if (isSupportedFile(entry.name) && !isGeneratedFile(entry.name)) yield full;
    }
  }
}

function tryGitLsFiles(dir: string): string[] | null {
  try {
    const result = spawnSync(
      "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    const files: string[] = [];
    const seen = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const fullPath = nodePath.resolve(dir, line);
      if (!isSupportedFile(fullPath)) continue;
      if (isGeneratedFile(nodePath.basename(fullPath))) continue;
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
        const real = fs.realpathSync.native(fullPath);
        if (seen.has(real)) continue;
        seen.add(real);
        files.push(real);
      } catch { /* racy delete */ }
    }
    return files;
  } catch { return null; }
}

function discoverFiles(cwd: string): string[] {
  return tryGitLsFiles(cwd) ?? [...walkFiles(cwd)];
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitCommitSha(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
    return result.stdout?.trim() || "unknown";
  } catch { return "unknown"; }
}

function gitRepoName(cwd: string): string {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8" });
    const url = result.stdout?.trim();
    if (url) {
      // Extract "org/repo" from git URL
      const match = url.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch { /* fall through */ }
  return nodePath.basename(cwd);
}

// ---------------------------------------------------------------------------
// File manifest
// ---------------------------------------------------------------------------

interface FileManifest {
  path: string;       // workspace-relative POSIX path
  sha256: string;
  byteSize: number;
  language: string;
  content: Buffer;     // retained for upload — NOT sent to /begin
}

function buildManifest(cwd: string, filePaths: string[]): FileManifest[] {
  const manifest: FileManifest[] = [];
  for (const absPath of filePaths) {
    const lang = languageFromPath(absPath);
    if (!lang) continue;
    let content: Buffer;
    try { content = fs.readFileSync(absPath); }
    catch { continue; }
    if (content.length > MAX_FILE_BYTES) continue;
    if (content.length === 0) continue;

    const relPath = nodePath.relative(cwd, absPath).split(nodePath.sep).join("/");
    manifest.push({
      path: relPath,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      byteSize: content.length,
      language: lang,
      content,
    });
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Repo-splitter API types
// ---------------------------------------------------------------------------

interface BeginResponse {
  jobId: string;
  state: string;
  idempotent: boolean;
  fileCount: number;
}

interface SignResponse {
  uploads: UploadInfo[];
}

interface UploadInfo {
  path: string;
  sha256: string;
  language: string;
  byteSize: number;
  gsUri: string;
  uploadUrl: string | null;
  method: string;
  headers: Record<string, string>;
}

interface StatusResponse {
  jobId: string;
  state: string;
  expectedFileCount: number;
  filesPublished: number;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiPost<T>(
  endpoint: string,
  path: string,
  body: unknown,
  authToken?: string,
  timeoutMs = 60_000,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function apiGet<T>(
  endpoint: string,
  path: string,
  authToken?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const resp = await fetch(`${endpoint}${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Parallel upload with concurrency limit
// ---------------------------------------------------------------------------

async function uploadOneWithRetry(
  item: UploadInfo,
  body: Uint8Array,
  maxRetries = 5,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(item.uploadUrl!, {
      method: item.method,
      headers: item.headers,
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(120_000),
    });
    if (resp.ok) return;
    if (resp.status === 429 && attempt < maxRetries) {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const text = await resp.text();
    throw new Error(`Upload failed for ${item.path}: ${resp.status} ${text}`);
  }
}

async function uploadFiles(
  uploads: UploadInfo[],
  manifestByPath: Map<string, FileManifest>,
  concurrency: number,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const needsUpload = uploads.filter(u => u.uploadUrl !== null);
  let done = 0;
  const total = needsUpload.length;
  onProgress(done, total);

  const queue = [...needsUpload];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const file = manifestByPath.get(item.path);
      if (!file) continue;
      await uploadOneWithRetry(item, new Uint8Array(file.content));
      done++;
      onProgress(done, total);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Batch /files calls (500 files per batch)
// ---------------------------------------------------------------------------

const FILES_BATCH_SIZE = 500;

async function publishFiles(
  endpoint: string,
  jobId: string,
  manifest: FileManifest[],
  authToken?: string,
): Promise<number> {
  let totalPublished = 0;
  for (let i = 0; i < manifest.length; i += FILES_BATCH_SIZE) {
    const batch = manifest.slice(i, i + FILES_BATCH_SIZE);
    const resp = await apiPost<{ published: number }>(
      endpoint,
      `/v1/ingest/${jobId}/files`,
      {
        files: batch.map(f => ({
          path: f.path,
          sha256: f.sha256,
          byteSize: f.byteSize,
          language: f.language,
        })),
      },
      authToken,
    );
    totalPublished += resp.published;
  }
  return totalPublished;
}

// ---------------------------------------------------------------------------
// RemoteRunner implementation
// ---------------------------------------------------------------------------

export interface RemoteRunnerConfig {
  repoSplitterEndpoint: string;
  orgId?: string;
}

export function createRemoteRunner(config: RemoteRunnerConfig): RemoteRunner {
  return {
    async runIngestion(opts: RemoteIngestOptions): Promise<void> {
      const { cwd, silent, format } = opts;
      let authToken = await refreshAuthIfNeeded() ?? getAuthToken();
      const isJson = format === "json";

      // 1. Discover files
      if (!silent && !isJson) {
        process.stderr.write(chalk.dim("  Discovering files...\n"));
      }
      const filePaths = discoverFiles(cwd);
      if (filePaths.length === 0) {
        if (!silent && !isJson) {
          console.log(chalk.yellow("  No supported source files found."));
        }
        return;
      }

      // 2. Build manifest (read + hash)
      if (!silent && !isJson) {
        process.stderr.write(chalk.dim(`  Hashing ${filePaths.length} files...\n`));
      }
      const manifest = buildManifest(cwd, filePaths);
      if (manifest.length === 0) {
        if (!silent && !isJson) {
          console.log(chalk.yellow("  No parseable files after filtering."));
        }
        return;
      }

      const manifestByPath = new Map(manifest.map(f => [f.path, f]));
      const repo = gitRepoName(cwd);
      const commitSha = gitCommitSha(cwd);
      const orgId = config.orgId || "cli";
      const idempotencyKey = `${repo}:${commitSha}:${Date.now()}`;

      // 3. POST /begin
      if (!silent && !isJson) {
        process.stderr.write(
          chalk.dim(`  Starting remote ingest: ${manifest.length} files → ${config.repoSplitterEndpoint}\n`),
        );
      }
      const beginResp = await apiPost<BeginResponse>(
        config.repoSplitterEndpoint,
        "/v1/ingest/begin",
        {
          orgId,
          repo,
          commitSha,
          mode: "INITIAL",
          idempotencyKey,
          files: manifest.map(f => ({
            path: f.path,
            sha256: f.sha256,
            byteSize: f.byteSize,
            language: f.language,
          })),
        },
        authToken,
        5 * 60_000, // 5 min — large repos need time for Firestore + Kafka
      );

      const { jobId } = beginResp;
      if (!silent && !isJson) {
        process.stderr.write(chalk.dim(`  Job ${jobId.slice(0, 8)}... created\n`));
      }

      // 4. Stream: sign → upload → publish in batches so parsing begins
      //    while remaining files are still uploading.
      const BATCH_SIZE = 500;
      let totalUploaded = 0;
      let totalSkipped = 0;
      let totalPublished = 0;

      for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
        const batch = manifest.slice(i, i + BATCH_SIZE);

        // Refresh token if close to expiry (long uploads can exceed 15min JWT)
        authToken = await refreshAuthIfNeeded() ?? authToken;

        // 4a. Sign this batch
        const signResp = await apiPost<SignResponse>(
          config.repoSplitterEndpoint,
          `/v1/ingest/${jobId}/sign`,
          {
            orgId,
            files: batch.map(f => ({
              path: f.path,
              sha256: f.sha256,
              byteSize: f.byteSize,
              language: f.language,
            })),
          },
          authToken,
          2 * 60_000,
        );

        // 4b. Upload this batch to GCS
        const batchUploads = signResp.uploads;
        const needsUpload = batchUploads.filter(u => u.uploadUrl !== null);
        totalSkipped += batchUploads.length - needsUpload.length;

        if (needsUpload.length > 0) {
          await uploadFiles(batchUploads, manifestByPath, 8, (done) => {
            if (!silent && !isJson) {
              process.stderr.write(
                `\r  Uploading & publishing... ${totalUploaded + done}/${manifest.length}`,
              );
            }
          });
          totalUploaded += needsUpload.length;
        }

        // 4c. Publish this batch to Kafka immediately — parse-worker
        //     starts consuming while the next batch is still signing/uploading.
        const filesResp = await apiPost<{ published: number }>(
          config.repoSplitterEndpoint,
          `/v1/ingest/${jobId}/files`,
          {
            files: batch.map(f => ({
              path: f.path,
              sha256: f.sha256,
              byteSize: f.byteSize,
              language: f.language,
            })),
          },
          authToken,
        );
        totalPublished += filesResp.published;
      }

      if (!silent && !isJson) {
        process.stderr.write(
          `\r  Uploaded ${totalUploaded} files, ${totalSkipped} deduped, ${totalPublished} published\n`,
        );
      }

      // 6. POST /done
      await apiPost(
        config.repoSplitterEndpoint,
        `/v1/ingest/${jobId}/done`,
        {},
        authToken,
      );
      if (!silent && !isJson) {
        process.stderr.write(chalk.dim(`  Ingest job ${jobId.slice(0, 8)}... completed\n`));
      }

      // 7. Wait for pipeline to drain (graph-writer needs time to process)
      if (!silent && !isJson) {
        process.stderr.write(chalk.dim("  Waiting for pipeline to process...\n"));
      }
      await waitForPipeline(
        config.repoSplitterEndpoint,
        jobId,
        manifest.length,
        authToken,
        silent,
        isJson,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline drain wait — polls /v1/stats for graph node count until it
// reaches the expected file count or stabilises (stops growing).
//
// Phase 1: poll /v1/ingest/:jobId/status until state === "done"
//          (all files published to Kafka).
// Phase 2: poll GET /v1/stats (memory-layer via tunnel) and watch the
//          "file" kind count. Done when it reaches expectedFiles or
//          the count hasn't changed for `stableChecks` consecutive polls.
// ---------------------------------------------------------------------------

interface StatsResponse {
  nodes: {
    total: number;
    byKind: Array<{ kind: string; count: number }>;
  };
  edges: {
    total: number;
    byPredicate: Array<{ predicate: string; count: number }>;
  };
}

async function waitForPipeline(
  endpoint: string,
  jobId: string,
  expectedFiles: number,
  authToken?: string,
  silent?: boolean,
  isJson?: boolean,
): Promise<void> {
  // Phase 1: wait for repo-splitter to confirm all files published.
  const publishMaxMs = 5 * 60 * 1000;
  const pollIntervalMs = 2_000;
  let start = Date.now();

  while (Date.now() - start < publishMaxMs) {
    try {
      const status = await apiGet<StatusResponse>(
        endpoint,
        `/v1/ingest/${jobId}/status`,
        authToken,
      );
      if (status.state === "done") break;
    } catch { /* ignore transient errors */ }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Phase 2: poll /v1/stats for graph file count.
  if (!silent && !isJson) {
    process.stderr.write(chalk.dim("  Waiting for graph to populate...\n"));
  }

  const graphMaxMs = 15 * 60 * 1000; // 15 min max for large repos
  const graphPollMs = 5_000;
  const stableChecks = 6; // 6 consecutive polls (30s) with no growth → done
  let lastFileCount = 0;
  let stableCount = 0;
  start = Date.now();

  while (Date.now() - start < graphMaxMs) {
    await new Promise(r => setTimeout(r, graphPollMs));

    let fileCount = 0;
    try {
      const stats = await apiGet<StatsResponse>(endpoint, "/v1/stats", authToken);
      const fileEntry = stats.nodes.byKind.find(e => e.kind === "file");
      fileCount = fileEntry?.count ?? 0;
    } catch {
      // Stats endpoint might not be available yet — keep polling.
      continue;
    }

    if (!silent && !isJson) {
      process.stderr.write(
        `\r  Graph: ${fileCount}/${expectedFiles} files written...`,
      );
    }

    if (fileCount >= expectedFiles) {
      break;
    }

    if (fileCount === lastFileCount) {
      stableCount++;
      if (stableCount >= stableChecks) {
        // Count stopped growing — pipeline is likely done (some files may
        // have been filtered or deduped by downstream workers).
        break;
      }
    } else {
      stableCount = 0;
    }
    lastFileCount = fileCount;
  }

  if (!silent && !isJson) {
    process.stderr.write("\n");
  }
}
