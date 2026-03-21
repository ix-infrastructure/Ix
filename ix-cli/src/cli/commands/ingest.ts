import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
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

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next',
  '.cache', '__pycache__', '.ix', '.claude', '.gitnexus',
]);

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

function* walkFiles(
  dir: string,
  recursive: boolean,
  supportsFile: (fileName: string) => boolean
): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walkFiles(full, true, supportsFile);
    } else if (entry.isFile()) {
      if (supportsFile(entry.name)) yield full;
    }
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
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

  const [{ parseFile, resolveEdges, isGrammarSupported }, { buildPatchWithResolution }] = await loadIngestionModules();
  const moduleLoadMs = Math.round(performance.now() - trueStart);

  const resolvedPath = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(resolveWorkspaceRoot(opts.root), path);

  const client = new IxClient(getEndpoint());
  const start = performance.now();

  let progressPhase   = 'Scanning';
  let progressCurrent = 0;
  let progressTotal   = 0;
  const interval = opts.format === 'text' ? setInterval(() => {
    process.stderr.write('\r' + renderProgressLine(progressPhase, progressCurrent, progressTotal));
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
  const timings = { moduleLoadMs, discoverMs: 0, hashMs: 0, parseMs: 0, resolveMs: 0, commitMs: 0 };
  const resolveStats = {
    importLookups: 0, transitiveLookups: 0, globalFallbacks: 0,
    globalCandidateTotal: 0, resolvedImport: 0, resolvedTransitive: 0,
    resolvedGlobal: 0, resolvedQualifier: 0, skippedSameFile: 0, skippedAmbiguous: 0,
  };

  try {
    // Phase: discover files
    const stat = fs.statSync(resolvedPath);
    const filePaths: string[] = stat.isFile()
      ? [resolvedPath]
      : Array.from(walkFiles(resolvedPath, opts.recursive ?? true, isGrammarSupported));

    filesDiscovered = filePaths.length;
    const discovered = performance.now();
    timings.discoverMs = Math.round(discovered - start);

    progressPhase   = 'Parsing';
    progressTotal   = filePaths.length;
    progressCurrent = 0;

    // Phase: hash lookup (skipped on first ingest when no baseline exists)
    let knownHashes: Map<string, string>;
    let baselineSkipped = false;
    if (opts.force) {
      knownHashes = new Map();
    } else {
      const hasBaseline = await checkIngestBaseline(client, debug);
      if (hasBaseline) {
        if (debug) process.stderr.write('\n  Existing ingest baseline found — performing source hash comparison\n');
        knownHashes = await loadExistingHashes(client, filePaths, debug);
      } else {
        if (debug) process.stderr.write('\n  No existing ingest baseline found — skipping source hash lookup\n');
        knownHashes = new Map();
        baselineSkipped = true;
      }
    }
    const hashed = performance.now();
    timings.hashMs = Math.round(hashed - discovered);

    // Phase: parse all files
    type ParsedFile = { filePath: string; parsed: any; hash: string; previousHash: string | undefined };
    const parsedFiles: ParsedFile[] = [];

    for (const filePath of filePaths) {
      progressCurrent++;
      if (interval) process.stderr.write('\r' + renderProgressLine(progressPhase, progressCurrent, progressTotal));
      try {
        const fileSize = fs.statSync(filePath).size;
        if (fileSize === 0) { filesSkipped++; continue; }
        if (fileSize > MAX_FILE_BYTES) { tooLarge++; continue; }

        const bytes = fs.readFileSync(filePath);
        const hash = sha256(bytes);

        if (!opts.force && knownHashes.get(filePath) === hash) {
          filesSkipped++;
          continue;
        }

        const source = bytes.toString('utf-8');
        const parsed = parseFile(filePath, source);

        if (!parsed) {
          filesSkipped++;
          continue;
        }

        entitiesParsed += parsed.entities.length;
        const previousHash = knownHashes.get(filePath);
        parsedFiles.push({ filePath, parsed, hash, previousHash: previousHash !== hash ? previousHash : undefined });
      } catch (err) {
        parseErrors++;
        process.stderr.write(`\n  [parse error] ${filePath}: ${err}\n`);
      }
    }

    filesChanged = parsedFiles.length;
    const parsed = performance.now();
    timings.parseMs = Math.round(parsed - hashed);

    // Phase: cross-file CALLS + EXTENDS resolution over the full batch
    const resolvedEdges = (resolveEdges as Function)(parsedFiles.map(f => f.parsed), resolveStats);
    const resolved = performance.now();
    timings.resolveMs = Math.round(resolved - parsed);

    // Pre-group resolved edges by source file for O(1) lookup in patch building
    const edgesByFile = new Map<string, typeof resolvedEdges>();
    for (const edge of resolvedEdges) {
      let arr = edgesByFile.get(edge.srcFilePath);
      if (!arr) { arr = []; edgesByFile.set(edge.srcFilePath, arr); }
      arr.push(edge);
    }
    const emptyEdges: typeof resolvedEdges = [];

    // Phase: build patches and bulk commit
    const patches: GraphPatchPayload[] = [];
    for (const { parsed: p, hash, previousHash } of parsedFiles) {
      try {
        patches.push(buildPatchWithResolution(p, hash, edgesByFile.get(p.filePath) ?? emptyEdges, previousHash));
      } catch (err) {
        parseErrors++;
        process.stderr.write(`\n  [patch build error] ${p.filePath}: ${err}\n`);
      }
    }

    if (patches.length > 0) {
      progressPhase   = 'Saving';
      progressTotal   = patches.length;
      progressCurrent = 0;
      try {
        const result = await client.commitPatchBulk(patches);
        latestRev = result.rev;
        patchesApplied = patches.length;
        progressCurrent = patches.length;
      } catch (err) {
        // Fallback: try per-file commits if bulk endpoint fails
        if (debug) process.stderr.write(`\n  [bulk commit failed, falling back to per-file] ${err}\n`);
        for (const patch of patches) {
          try {
            const result = await client.commitPatch(patch);
            if (result.rev > latestRev) latestRev = result.rev;
            patchesApplied++;
            progressCurrent++;
          } catch (commitErr) {
            parseErrors++;
            process.stderr.write(`\n  [commit error] ${patch.source?.uri}: ${commitErr}\n`);
          }
        }
      }
    }

    const committed = performance.now();
    timings.commitMs = Math.round(committed - resolved);
  } finally {
    if (interval) {
      clearInterval(interval);
      if (progressTotal > 0) {
        process.stderr.write('\r' + renderProgressLine(progressPhase, progressTotal, progressTotal));
      }
      process.stderr.write('\r' + ' '.repeat(PROG_LINE_WIDTH) + '\r');
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

async function checkIngestBaseline(client: IxClient, debug = false): Promise<boolean> {
  try {
    return await client.hasIngestBaseline();
  } catch (err) {
    if (debug) process.stderr.write(`\n  [baseline check failed, falling back to full hash lookup] ${err}\n`);
    return true; // Safe fallback: assume baseline exists, do the full lookup
  }
}

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
