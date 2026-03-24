import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { Command } from 'commander';
import chalk from 'chalk';
import { IxClient } from '../../client/api.js';
import type { GraphPatchPayload } from '../../client/types.js';
import { getEndpoint, resolveWorkspaceRoot } from '../config.js';
import { resolveGitHubToken } from '../github/auth.js';
import { parseGitHubRepo, fetchGitHubData } from '../github/fetch.js';
import { loadIngestionModules } from './ingestion-loader.js';
import {
  deterministicId,
  transformIssue,
  transformIssueComment,
  transformPR,
  transformPRComment,
  transformCommit,
} from '../github/transform.js';
// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

// Inline extension set — mirrors core-ingestion/dist/languages.js EXT_MAP.
// Kept here so file discovery does NOT require loading tree-sitter grammars.
const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
  '.cs', '.go', '.rb', '.rs', '.php', '.kt', '.kts', '.swift',
  '.scala', '.sc',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next',
  '.cache', '__pycache__', '.ix', '.claude', '.gitnexus',
]);

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

function* walkFiles(
  dir: string,
  recursive: boolean,
): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walkFiles(full, true);
    } else if (entry.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(nodePath.extname(entry.name))) yield full;
    }
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Mtime cache — skip readFileSync+sha256 for unchanged files
// ---------------------------------------------------------------------------

interface MtimeCache {
  root: string;
  files: Record<string, number>; // absolute path → mtime (ms)
}

function mtimeCachePath(projectRoot: string): string {
  const key = crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
  return nodePath.join(os.homedir(), '.ix', `ingest_mtimes_${key}.json`);
}

function loadMtimeCache(projectRoot: string): Map<string, number> {
  try {
    const raw = fs.readFileSync(mtimeCachePath(projectRoot), 'utf-8');
    const data = JSON.parse(raw) as MtimeCache;
    if (data.root !== projectRoot) return new Map();
    return new Map(Object.entries(data.files));
  } catch {
    return new Map();
  }
}

function saveMtimeCache(projectRoot: string, mtimes: Map<string, number>): void {
  try {
    const dir = nodePath.join(os.homedir(), '.ix');
    fs.mkdirSync(dir, { recursive: true });
    const data: MtimeCache = { root: projectRoot, files: Object.fromEntries(mtimes) };
    fs.writeFileSync(mtimeCachePath(projectRoot), JSON.stringify(data));
  } catch {
    // Non-critical: ignore write errors
  }
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

const PROG_BAR_WIDTH  = 25;
const PROG_LINE_WIDTH = 72;

function renderProgressLine(phase: string, current: number, total: number): string {
  if (total === 0) {
    return `  ${phase}...`.padEnd(PROG_LINE_WIDTH);
  }
  const pct    = Math.min(current / total, 1);
  const filled = Math.round(pct * PROG_BAR_WIDTH);
  const bar    = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(PROG_BAR_WIDTH - filled));
  const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
  const w      = total.toString().length;
  const count  = `${current.toString().padStart(w)} / ${total}`;
  return `  ${phase.padEnd(8)}  ${bar}  ${pctStr}  ${count}`.padEnd(PROG_LINE_WIDTH);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerIngestCommand(program: Command): void {
  program
    .command('ingest [path]')
    .description('Ingest source files or GitHub data into the knowledge graph')
    .option('--path <dir>', 'Path to ingest (alternative to positional argument)')
    .option('--no-recursive', 'Do not recurse into subdirectories (recursive is on by default)')
    .option('--github <owner/repo>', 'Ingest issues, PRs, and commits from a GitHub repository')
    .option('--token <pat>', 'GitHub personal access token')
    .option('--since <date>', 'Only fetch items updated after this date (ISO 8601)')
    .option('--limit <n>', 'Max items per category (default 50)', '50')
    .option('--force', 'Force re-ingest even if files are unchanged (useful after parser upgrades)')
    .option('--format <fmt>', 'Output format (text|json)', 'text')
    .option('--root <dir>', 'Workspace root directory')
    .option('--debug', 'Show phase timing breakdown', false)
    .addHelpText('after', '\nExamples:\n  ix ingest ./src\n  ix ingest --path ./src --force\n  ix ingest --github owner/repo\n  ix ingest --github owner/repo --since 2026-01-01 --limit 20 --format json\n  ix ingest --github owner/repo --token ghp_xxxx')
    .action(async (positionalPath: string | undefined, opts: {
      path?: string; recursive?: boolean; force?: boolean; github?: string; token?: string;
      since?: string; limit: string; format: string; root?: string; debug?: boolean;
    }) => {
      const effectivePath = positionalPath ?? opts.path;
      if (opts.github) {
        await ingestGitHub(opts);
      } else if (effectivePath) {
        await ingestFiles(effectivePath, opts);
      } else {
        console.error('Error: provide a <path> or use --github <owner/repo>');
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// File ingestion — parse locally, send via /v1/patch
// ---------------------------------------------------------------------------

export async function ingestFiles(
  path: string,
  opts: { recursive?: boolean; force?: boolean; format: string; root?: string; debug?: boolean; printSummary?: boolean }
): Promise<void> {
  const debug = opts.debug || process.env.IX_DEBUG === '1';
  const trueStart = performance.now();

  const resolvedPath = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(resolveWorkspaceRoot(opts.root), path);

  const client = new IxClient(getEndpoint());
  const start = performance.now();

  let progressPhase   = 'Scanning';
  let progressCurrent = 0;
  let progressTotal   = 0;
  let progressStart   = performance.now();

  const interval = opts.format === 'text' ? setInterval(() => {
    const elapsed   = performance.now() - progressStart;
    const tau       = progressPhase === 'Saving' ? 3000 : 2000;
    let display     = progressCurrent;
    if (progressTotal > 0 && progressCurrent < progressTotal) {
      const simulated = Math.floor((1 - Math.exp(-elapsed / tau)) * 0.88 * progressTotal);
      display = Math.max(display, simulated);
    }
    process.stderr.write('\r' + renderProgressLine(progressPhase, display, progressTotal));
  }, 80) : null;

  let filesDiscovered = 0;
  let filesChanged = 0;
  let patchesApplied = 0;
  let filesSkipped = 0;
  let parseErrors = 0;
  let tooLarge = 0;
  let latestRev = 0;
  let entitiesParsed = 0;

  // Phase timing marks
  const timings = { moduleLoadMs: 0, discoverMs: 0, hashMs: 0, parseMs: 0, resolveMs: 0, commitMs: 0 };
  const resolveStats = {
    importLookups: 0, transitiveLookups: 0, globalFallbacks: 0,
    globalCandidateTotal: 0, resolvedImport: 0, resolvedTransitive: 0,
    resolvedGlobal: 0, resolvedQualifier: 0, skippedSameFile: 0, skippedAmbiguous: 0,
  };

  try {
    // Phase: discover files
    const stat = fs.statSync(resolvedPath);
    const filePaths: string[] = stat.isFile()
      ? (SUPPORTED_EXTENSIONS.has(nodePath.extname(resolvedPath)) ? [resolvedPath] : [])
      : Array.from(walkFiles(resolvedPath, opts.recursive ?? true));

    filesDiscovered = filePaths.length;
    const discovered = performance.now();
    timings.discoverMs = Math.round(discovered - start);

    progressPhase   = 'Parsing';
    progressTotal   = filePaths.length;
    progressCurrent = 0;
    progressStart   = performance.now();

    // Phase: mtime pre-filter — skip readFileSync+sha256 for files whose mtime
    // is unchanged since the last successful ingest (common "ix map" re-run case).
    const projectRoot = fs.statSync(resolvedPath).isDirectory() ? resolvedPath : nodePath.dirname(resolvedPath);
    const mtimeCache  = opts.force ? new Map<string, number>() : loadMtimeCache(projectRoot);
    const currentMtimes = new Map<string, number>();

    // DB-reset guard: if the mtime cache has entries but the server returns no hashes
    // for a small sample, the DB was wiped (e.g. `ix reset` run from a different dir
    // so the cache wasn't cleared). Invalidate the cache so files are re-ingested.
    if (!opts.force && mtimeCache.size > 0) {
      const samplePaths = [...mtimeCache.keys()].slice(0, 5);
      const sampleHashes = await loadExistingHashes(client, samplePaths, debug);
      if (sampleHashes.size === 0) {
        mtimeCache.clear();
        if (debug) process.stderr.write(`\n  DB reset detected — invalidating mtime cache\n`);
      }
    }

    // Stat all files and partition into mtime-clean (skip) and mtime-changed (need hash check).
    const mtimeChangedPaths: string[] = [];
    for (const filePath of filePaths) {
      try {
        const st = fs.statSync(filePath);
        if (st.size === 0) { filesSkipped++; continue; }
        if (st.size > MAX_FILE_BYTES) { tooLarge++; continue; }
        const mtime = st.mtimeMs;
        currentMtimes.set(filePath, mtime);
        if (!opts.force && mtimeCache.get(filePath) === mtime) {
          filesSkipped++;   // mtime clean — assume unchanged
        } else {
          mtimeChangedPaths.push(filePath);
        }
      } catch (err) {
        parseErrors++;
        process.stderr.write(`\n  [stat error] ${filePath}: ${err}\n`);
      }
    }

    // Phase: hash lookup — only needed when mtime-changed files exist.
    let knownHashes: Map<string, string>;
    if (opts.force || mtimeChangedPaths.length > 0) {
      knownHashes = await loadExistingHashes(client, opts.force ? filePaths : mtimeChangedPaths, debug);
      if (debug) process.stderr.write(`\n  Source hash lookup: ${knownHashes.size} known hashes (${mtimeChangedPaths.length} mtime-changed)\n`);
    } else {
      // All files are mtime-clean — skip server round-trip entirely.
      knownHashes = new Map();
      if (debug) process.stderr.write(`\n  All ${filePaths.length} files mtime-clean — skipping hash lookup\n`);
    }
    const hashed = performance.now();
    timings.hashMs = Math.round(hashed - discovered);

    // Phase: parse + commit — streaming to bound peak memory.
    //
    // Files are parsed in PARSE_STREAM_CHUNK-sized batches. After each batch,
    // resolveEdges runs on that batch and patches are committed before the next
    // batch is parsed. This keeps heap usage at O(chunk) instead of O(total).
    //
    // YIELD_EVERY yields the Node.js event loop so the progress bar timer can
    // fire even during the synchronous tree-sitter parse calls.
    //
    // Two paths:
    //   A) Has baseline or mtime-changed files → pre-scan first, skip module load
    //      entirely if nothing changed (common "ix map" re-run case).
    //   B) No baseline / force → load modules, parse + stream-commit all files.

    type ParsedFile = { filePath: string; parsed: any; hash: string; previousHash: string | undefined };
    let resolveEdgesFn: Function | null = null;
    let buildPatchFn: Function | null = null;

    const PARSE_STREAM_CHUNK = 1000;  // resolve + commit after this many parsed files
    const COMMIT_CHUNK_SIZE   = 200;  // files per HTTP batch to server
    const YIELD_EVERY         = 100;  // yield event loop every N files during parse

    const emptyEdges: any[] = [];

    /** Resolve edges within a batch, build patches, and commit in sub-chunks. */
    const flushBatch = async (batch: ParsedFile[]): Promise<void> => {
      if (batch.length === 0) return;
      filesChanged += batch.length;

      const resolvedEdges = resolveEdgesFn!(batch.map(f => f.parsed), resolveStats);
      const batchEdgesByFile = new Map<string, any[]>();
      for (const edge of resolvedEdges) {
        let arr = batchEdgesByFile.get(edge.srcFilePath);
        if (!arr) { arr = []; batchEdgesByFile.set(edge.srcFilePath, arr); }
        arr.push(edge);
      }

      for (let i = 0; i < batch.length; i += COMMIT_CHUNK_SIZE) {
        const end = Math.min(i + COMMIT_CHUNK_SIZE, batch.length);
        const patchChunk: GraphPatchPayload[] = [];
        for (let j = i; j < end; j++) {
          const { parsed: p, hash, previousHash } = batch[j];
          try {
            patchChunk.push(buildPatchFn!(p, hash, batchEdgesByFile.get(p.filePath) ?? emptyEdges, previousHash));
          } catch (err) {
            parseErrors++;
            process.stderr.write(`\n  [patch build error] ${p.filePath}: ${err}\n`);
          }
        }
        if (patchChunk.length === 0) continue;
        try {
          const result = await client.commitPatchBulk(patchChunk);
          if (result.rev > latestRev) latestRev = result.rev;
          patchesApplied += patchChunk.length;
        } catch (err) {
          if (debug) process.stderr.write(`\n  [bulk chunk failed, falling back to per-file] ${err}\n`);
          for (const patch of patchChunk) {
            try {
              const result = await client.commitPatch(patch);
              if (result.rev > latestRev) latestRev = result.rev;
              patchesApplied++;
            } catch (commitErr) {
              parseErrors++;
              process.stderr.write(`\n  [commit error] ${patch.source?.uri}: ${commitErr}\n`);
            }
          }
        }
      }
    };

    if ((knownHashes.size > 0 || mtimeChangedPaths.length === 0) && !opts.force) {
      // Path A: has baseline or all mtime-clean → pre-scan to detect changes before loading modules.
      // If nothing changed, module load is skipped entirely.
      const changedPaths: Array<{ filePath: string; bytes: Buffer; hash: string; previousHash: string | undefined }> = [];
      for (const filePath of mtimeChangedPaths) {
        try {
          const bytes = fs.readFileSync(filePath);
          const hash = sha256(bytes);
          if (knownHashes.get(filePath) === hash) { filesSkipped++; continue; }
          const previousHash = knownHashes.get(filePath);
          changedPaths.push({ filePath, bytes, hash, previousHash: previousHash !== hash ? previousHash : undefined });
        } catch (err) {
          parseErrors++;
          process.stderr.write(`\n  [read error] ${filePath}: ${err}\n`);
        }
      }

      if (changedPaths.length > 0) {
        const moduleStart = performance.now();
        const [ingestion, patchBuilder] = await loadIngestionModules();
        timings.moduleLoadMs = Math.round(performance.now() - moduleStart);
        resolveEdgesFn = ingestion.resolveEdges as Function;
        buildPatchFn = patchBuilder.buildPatchWithResolution as Function;

        let batch: ParsedFile[] = [];
        for (let i = 0; i < changedPaths.length; i++) {
          const { filePath, bytes, hash, previousHash } = changedPaths[i];
          try {
            const parsed = (ingestion.parseFile as Function)(filePath, bytes.toString('utf-8'));
            if (!parsed) { filesSkipped++; progressCurrent++; continue; }
            entitiesParsed += parsed.entities.length;
            batch.push({ filePath, parsed, hash, previousHash });
            progressCurrent++;
          } catch (err) {
            parseErrors++;
            progressCurrent++;
            process.stderr.write(`\n  [parse error] ${filePath}: ${err}\n`);
          }
          if ((i + 1) % YIELD_EVERY === 0) await new Promise<void>(resolve => setImmediate(resolve));
          if (batch.length >= PARSE_STREAM_CHUNK) { await flushBatch(batch); batch = []; }
        }
        await flushBatch(batch);
      }
    } else {
      // Path B: no baseline (first ingest) or --force → load modules, then stream parse + commit.
      const moduleStart = performance.now();
      const [ingestion, patchBuilder] = await loadIngestionModules();
      timings.moduleLoadMs = Math.round(performance.now() - moduleStart);
      resolveEdgesFn = ingestion.resolveEdges as Function;
      buildPatchFn = patchBuilder.buildPatchWithResolution as Function;

      let batch: ParsedFile[] = [];
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        try {
          const fileSize = fs.statSync(filePath).size;
          if (fileSize === 0) { filesSkipped++; progressCurrent++; continue; }
          if (fileSize > MAX_FILE_BYTES) { tooLarge++; progressCurrent++; continue; }
          const bytes = fs.readFileSync(filePath);
          const hash = sha256(bytes);
          if (!opts.force && knownHashes.get(filePath) === hash) { filesSkipped++; progressCurrent++; continue; }
          const previousHash = knownHashes.get(filePath);
          const parsed = (ingestion.parseFile as Function)(filePath, bytes.toString('utf-8'));
          if (!parsed) { filesSkipped++; progressCurrent++; continue; }
          entitiesParsed += parsed.entities.length;
          batch.push({ filePath, parsed, hash, previousHash: previousHash !== hash ? previousHash : undefined });
          progressCurrent++;
        } catch (err) {
          parseErrors++;
          progressCurrent++;
          process.stderr.write(`\n  [parse error] ${filePath}: ${err}\n`);
        }
        if ((i + 1) % YIELD_EVERY === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (batch.length >= PARSE_STREAM_CHUNK) { await flushBatch(batch); batch = []; }
      }
      await flushBatch(batch);
    }

    const parsed = performance.now();
    timings.parseMs = Math.round(parsed - hashed);
    timings.resolveMs = 0;   // now interleaved with parse
    timings.commitMs  = 0;   // now interleaved with parse

    // Clear the parse bar
    if (interval) process.stderr.write('\r' + ' '.repeat(PROG_LINE_WIDTH) + '\r');

    const committed = performance.now();

    // Persist mtime cache so next run can skip unchanged files quickly.
    // Only save when no parse errors (avoid poisoning cache on partial failures).
    if (!opts.force && parseErrors === 0 && currentMtimes.size > 0) {
      saveMtimeCache(projectRoot, currentMtimes);
    }
  } finally {
    if (interval) {
      clearInterval(interval);
      if (progressTotal > 0) {
        process.stderr.write('\r' + renderProgressLine(progressPhase, progressTotal, progressTotal));
      }
      process.stderr.write('\r' + ' '.repeat(PROG_LINE_WIDTH) + '\r');
      const elapsedSec = ((performance.now() - start) / 1000).toFixed(1);
      process.stderr.write(chalk.dim(`  Ingested in ${elapsedSec}s\n`));
    }
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      filesProcessed: filesDiscovered,
      filesChanged,
      patchesApplied,
      filesSkipped,
      entitiesParsed,
      latestRev,
      skipReasons: { unchanged: filesSkipped, emptyFile: 0, parseError: parseErrors, tooLarge },
      elapsedSeconds: parseFloat(elapsed),
      timings,
      resolveStats,
    }, null, 2));
  } else if (opts.printSummary !== false) {
    console.log(chalk.bold('\nIngest summary'));
    console.log(`  processed:   ${patchesApplied} files (${elapsed}s)`);
    console.log(`  discovered:  ${filesDiscovered} files`);
    console.log(`  changed:     ${filesChanged} files`);
    if (filesSkipped > 0) console.log(`  ${chalk.dim('skipped unchanged:')} ${filesSkipped}`);
    if (parseErrors > 0) console.log(`  ${chalk.red('parse errors:')}      ${parseErrors}`);
    if (tooLarge > 0) console.log(`  ${chalk.dim('skipped too large:')} ${tooLarge}`);
    console.log(`  rev:         ${latestRev}`);

    if (patchesApplied === 0 && filesDiscovered === 0) {
      console.log(chalk.yellow('\n  Warning: No files found. Check the path and supported extensions.'));
    } else if (patchesApplied === 0 && filesDiscovered > 0) {
      console.log(chalk.dim('\n  All files unchanged since last ingest.'));
    }

    if (debug) {
      console.log(chalk.dim(`\n  Phase timings:`));
      console.log(chalk.dim(`    modules:  ${timings.moduleLoadMs}ms`));
      console.log(chalk.dim(`    discover: ${timings.discoverMs}ms`));
      console.log(chalk.dim(`    hash:     ${timings.hashMs}ms`));
      console.log(chalk.dim(`    parse:    ${timings.parseMs}ms`));
      console.log(chalk.dim(`    resolve:  ${timings.resolveMs}ms`));
      console.log(chalk.dim(`    commit:   ${timings.commitMs}ms`));
      console.log(chalk.dim(`\n  Resolve stats:`));
      console.log(chalk.dim(`    import lookups:     ${resolveStats.importLookups}`));
      console.log(chalk.dim(`    transitive lookups: ${resolveStats.transitiveLookups}`));
      console.log(chalk.dim(`    global fallbacks:   ${resolveStats.globalFallbacks}`));
      console.log(chalk.dim(`    avg candidates:     ${resolveStats.globalFallbacks > 0 ? (resolveStats.globalCandidateTotal / resolveStats.globalFallbacks).toFixed(1) : '0'}`));
      console.log(chalk.dim(`    resolved import:    ${resolveStats.resolvedImport}`));
      console.log(chalk.dim(`    resolved transitive:${resolveStats.resolvedTransitive}`));
      console.log(chalk.dim(`    resolved global:    ${resolveStats.resolvedGlobal}`));
      console.log(chalk.dim(`    resolved qualifier: ${resolveStats.resolvedQualifier}`));
      console.log(chalk.dim(`    skipped same-file:  ${resolveStats.skippedSameFile}`));
      console.log(chalk.dim(`    skipped ambiguous:  ${resolveStats.skippedAmbiguous}`));
    }

    console.log();
  }
}

// ---------------------------------------------------------------------------
// Load existing hashes from the server for change detection
// ---------------------------------------------------------------------------

async function loadExistingHashes(client: IxClient, filePaths: string[], debug = false): Promise<Map<string, string>> {
  try {
    return await client.getSourceHashes(filePaths);
  } catch (err) {
    if (debug) process.stderr.write(`\n  [hash lookup failed] ${err}\n`);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// GitHub ingestion (unchanged)
// ---------------------------------------------------------------------------

async function ingestGitHub(opts: {
  github?: string; token?: string; since?: string;
  limit: string; format: string;
}): Promise<void> {
  const repo = parseGitHubRepo(opts.github!);
  const token = await resolveGitHubToken(opts.token);
  const client = new IxClient(getEndpoint());
  const limit = parseInt(opts.limit, 10);
  const start = performance.now();

  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (opts.format !== 'json') {
    process.stderr.write(`Fetching from ${repo.owner}/${repo.repo} (since ${since})...\n`);
  }

  const data = await fetchGitHubData(repo, token, { since, limit });

  const allOps: any[] = [];
  for (const issue of data.issues) allOps.push(...transformIssue(repo, issue));
  for (const [issueNum, comments] of data.issueComments) {
    for (const comment of comments) allOps.push(...transformIssueComment(repo, issueNum, comment));
  }
  for (const pr of data.pullRequests) allOps.push(...transformPR(repo, pr));
  for (const [prNum, comments] of data.prComments) {
    for (const comment of comments) allOps.push(...transformPRComment(repo, prNum, comment));
  }
  for (const commit of data.commits) allOps.push(...transformCommit(repo, commit));

  const patch: GraphPatchPayload = {
    patchId: deterministicId(`github://${repo.owner}/${repo.repo}:${since}:${Date.now()}`),
    actor: 'ix/github-ingest',
    timestamp: new Date().toISOString(),
    source: {
      uri: `github://${repo.owner}/${repo.repo}`,
      extractor: 'github-ingest/1.0',
      sourceType: 'comment',
    },
    baseRev: 0,
    ops: allOps,
    replaces: [],
    intent: `GitHub ingestion: ${repo.owner}/${repo.repo}`,
  };

  const result = await client.commitPatch(patch);
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      source: `${repo.owner}/${repo.repo}`,
      issues: data.issues.length,
      pullRequests: data.pullRequests.length,
      commits: data.commits.length,
      totalOps: allOps.length,
      rev: result.rev,
      status: result.status,
      elapsedSeconds: parseFloat(elapsed),
    }, null, 2));
  } else {
    console.log(chalk.bold('\nGitHub ingest summary'));
    console.log(`  repo:            ${repo.owner}/${repo.repo}`);
    console.log(`  issues:          ${data.issues.length}`);
    console.log(`  pull requests:   ${data.pullRequests.length}`);
    console.log(`  commits:         ${data.commits.length}`);
    console.log(`  total ops:       ${allOps.length}`);
    console.log(`  rev:             ${result.rev}`);
    console.log(`  elapsed:         ${elapsed}s`);
    console.log();
  }
}
