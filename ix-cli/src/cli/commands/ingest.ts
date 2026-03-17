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
    .addHelpText('after', '\nExamples:\n  ix ingest ./src\n  ix ingest --path ./src --force\n  ix ingest --github owner/repo\n  ix ingest --github owner/repo --since 2026-01-01 --limit 20 --format json\n  ix ingest --github owner/repo --token ghp_xxxx')
    .action(async (positionalPath: string | undefined, opts: {
      path?: string; recursive?: boolean; force?: boolean; github?: string; token?: string;
      since?: string; limit: string; format: string; root?: string;
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
  opts: { recursive?: boolean; force?: boolean; format: string; root?: string }
): Promise<void> {
  const [{ parseFile, resolveEdges, isGrammarSupported }, { buildPatchWithResolution }] = await loadIngestionModules();
  const resolvedPath = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(resolveWorkspaceRoot(opts.root), path);

  const client = new IxClient(getEndpoint());
  const start = performance.now();

  const spinner = ['\u28CB', '\u28D9', '\u28F9', '\u28F8', '\u28FC', '\u28F4', '\u28E6', '\u28E7', '\u28C7', '\u28CF'];
  let spinIdx = 0;
  const interval = opts.format === 'text' ? setInterval(() => {
    const elapsed = ((performance.now() - start) / 1000).toFixed(0);
    process.stderr.write(`\r${spinner[spinIdx++ % spinner.length]} Ingesting... ${elapsed}s`);
  }, 200) : null;

  let filesDiscovered = 0;
  let patchesApplied = 0;
  let filesSkipped = 0;
  let parseErrors = 0;
  let tooLarge = 0;
  let latestRev = 0;
  let entitiesParsed = 0;

  try {
    // Collect files
    const stat = fs.statSync(resolvedPath);
    const filePaths: string[] = stat.isFile()
      ? [resolvedPath]
      : Array.from(walkFiles(resolvedPath, opts.recursive ?? true, isGrammarSupported));

    filesDiscovered = filePaths.length;

    // Load existing source hashes for change detection (unless --force)
    const knownHashes = opts.force ? new Map<string, string>() : await loadExistingHashes(client, filePaths);

    // Phase 1: parse all files
    type ParsedFile = { filePath: string; parsed: any; hash: string; previousHash: string | undefined };
    const parsedFiles: ParsedFile[] = [];

    for (const filePath of filePaths) {
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

    // Phase 2: cross-file CALLS + EXTENDS resolution over the full batch
    const resolvedEdges = resolveEdges(parsedFiles.map(f => f.parsed));

    // Phase 3: build and commit patches
    for (const { parsed, hash, previousHash } of parsedFiles) {
      try {
        const patch = buildPatchWithResolution(parsed, hash, resolvedEdges, previousHash);
        const result = await client.commitPatch(patch);
        if (result.rev > latestRev) latestRev = result.rev;
        patchesApplied++;
      } catch (err) {
        parseErrors++;
        process.stderr.write(`\n  [commit error] ${parsed.filePath}: ${err}\n`);
      }
    }
  } finally {
    if (interval) {
      clearInterval(interval);
      process.stderr.write('\r' + ' '.repeat(40) + '\r');
    }
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      filesProcessed: filesDiscovered,
      patchesApplied,
      filesSkipped,
      entitiesParsed,
      latestRev,
      skipReasons: { unchanged: filesSkipped, emptyFile: 0, parseError: parseErrors, tooLarge },
      elapsedSeconds: parseFloat(elapsed),
    }, null, 2));
  } else {
    console.log(chalk.bold('\nIngest summary'));
    console.log(`  processed:   ${patchesApplied} files (${elapsed}s)`);
    console.log(`  discovered:  ${filesDiscovered} files`);
    if (filesSkipped > 0) console.log(`  ${chalk.dim('skipped unchanged:')} ${filesSkipped}`);
    if (parseErrors > 0) console.log(`  ${chalk.red('parse errors:')}      ${parseErrors}`);
    if (tooLarge > 0) console.log(`  ${chalk.dim('skipped too large:')} ${tooLarge}`);
    console.log(`  rev:         ${latestRev}`);

    if (patchesApplied === 0 && filesDiscovered === 0) {
      console.log(chalk.yellow('\n  Warning: No files found. Check the path and supported extensions.'));
    } else if (patchesApplied === 0 && filesDiscovered > 0) {
      console.log(chalk.dim('\n  All files unchanged since last ingest.'));
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Load existing hashes from the server for change detection
// ---------------------------------------------------------------------------

async function loadExistingHashes(client: IxClient, filePaths: string[]): Promise<Map<string, string>> {
  try {
    const hashes = await (client as any).getSourceHashes(filePaths);
    return new Map(Object.entries(hashes ?? {}));
  } catch {
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
