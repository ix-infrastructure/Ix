import * as nodePath from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import type { GraphPatchPayload } from "../../client/types.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { resolveGitHubToken } from "../github/auth.js";
import { parseGitHubRepo, fetchGitHubData } from "../github/fetch.js";
import {
  deterministicId,
  transformIssue,
  transformIssueComment,
  transformPR,
  transformPRComment,
  transformCommit,
} from "../github/transform.js";

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest [path]")
    .description("Ingest source files or GitHub data into the knowledge graph")
    .option("--recursive", "Recursively ingest directory")
    .option("--github <owner/repo>", "Ingest issues, PRs, and commits from a GitHub repository")
    .option("--token <pat>", "GitHub personal access token")
    .option("--since <date>", "Only fetch items updated after this date (ISO 8601)")
    .option("--limit <n>", "Max items per category (default 50)", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", "\nExamples:\n  ix ingest ./src --recursive\n  ix ingest --github owner/repo\n  ix ingest --github owner/repo --since 2026-01-01 --limit 20 --format json\n  ix ingest --github owner/repo --token ghp_xxxx")
    .action(async (path: string | undefined, opts: {
      recursive?: boolean; github?: string; token?: string;
      since?: string; limit: string; format: string; root?: string
    }) => {
      if (opts.github) {
        await ingestGitHub(opts);
      } else if (path) {
        await ingestFiles(path, opts);
      } else {
        console.error("Error: provide a <path> or use --github <owner/repo>");
        process.exit(1);
      }
    });
}

async function ingestFiles(
  path: string,
  opts: { recursive?: boolean; format: string; root?: string }
): Promise<void> {
  const resolvedPath = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(resolveWorkspaceRoot(opts.root), path);
  const client = new IxClient(getEndpoint());
  const start = performance.now();

  const spinner = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];
  let spinIdx = 0;
  const interval = opts.format === "text" ? setInterval(() => {
    const elapsed = ((performance.now() - start) / 1000).toFixed(0);
    process.stderr.write(`\r${spinner[spinIdx++ % spinner.length]} Ingesting... ${elapsed}s`);
  }, 200) : null;

  try {
    const result = await client.ingest(resolvedPath, opts.recursive);
    if (interval) {
      clearInterval(interval);
      process.stderr.write("\r" + " ".repeat(40) + "\r");
    }
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);

    if (opts.format === "json") {
      console.log(JSON.stringify({ ...result, elapsedSeconds: parseFloat(elapsed) }, null, 2));
    } else {
      console.log(chalk.bold("\nIngest summary"));
      console.log(`  processed:   ${result.patchesApplied} files (${elapsed}s)`);
      console.log(`  discovered:  ${result.filesProcessed} files`);
      if (result.skipReasons) {
        const sr = result.skipReasons;
        if (sr.unchanged > 0) console.log(`  ${chalk.dim("skipped unchanged:")} ${sr.unchanged}`);
        if (sr.emptyFile > 0) console.log(`  ${chalk.dim("skipped empty:")}     ${sr.emptyFile}`);
        if (sr.parseError > 0) console.log(`  ${chalk.red("parse errors:")}      ${sr.parseError}`);
        if (sr.tooLarge > 0) console.log(`  ${chalk.dim("skipped too large:")} ${sr.tooLarge}`);
      } else if (result.filesSkipped) {
        console.log(`  ${chalk.dim("skipped:")}  ${result.filesSkipped} unchanged files`);
      }
      console.log(`  rev:         ${result.latestRev}`);

      if (result.patchesApplied === 0 && result.filesProcessed === 0) {
        console.log(chalk.yellow("\n  Warning: No files ingested. The path may be outside the project root,"));
        console.log(chalk.yellow("    contain no supported file types, or not exist."));
      } else if (result.patchesApplied === 0 && result.filesProcessed > 0) {
        console.log(chalk.dim("\n  All files unchanged since last ingest."));
      }
      console.log();
    }
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function ingestGitHub(opts: {
  github?: string; token?: string; since?: string;
  limit: string; format: string
}): Promise<void> {
  const repo = parseGitHubRepo(opts.github!);
  const token = await resolveGitHubToken(opts.token);
  const client = new IxClient(getEndpoint());
  const limit = parseInt(opts.limit, 10);
  const start = performance.now();

  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (opts.format !== "json") {
    process.stderr.write(`Fetching from ${repo.owner}/${repo.repo} (since ${since})...\n`);
  }

  const data = await fetchGitHubData(repo, token, { since, limit });

  const allOps: any[] = [];

  for (const issue of data.issues) {
    allOps.push(...transformIssue(repo, issue));
  }
  for (const [issueNum, comments] of data.issueComments) {
    for (const comment of comments) {
      allOps.push(...transformIssueComment(repo, issueNum, comment));
    }
  }
  for (const pr of data.pullRequests) {
    allOps.push(...transformPR(repo, pr));
  }
  for (const [prNum, comments] of data.prComments) {
    for (const comment of comments) {
      allOps.push(...transformPRComment(repo, prNum, comment));
    }
  }
  for (const commit of data.commits) {
    allOps.push(...transformCommit(repo, commit));
  }

  const patch: GraphPatchPayload = {
    patchId: deterministicId(`github://${repo.owner}/${repo.repo}:${since}:${Date.now()}`),
    actor: "ix/github-ingest",
    timestamp: new Date().toISOString(),
    source: {
      uri: `github://${repo.owner}/${repo.repo}`,
      extractor: "github-ingest/1.0",
      sourceType: "comment",
    },
    baseRev: 0,
    ops: allOps,
    replaces: [],
    intent: `GitHub ingestion: ${repo.owner}/${repo.repo}`,
  };

  const result = await client.commitPatch(patch);
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (opts.format === "json") {
    console.log(JSON.stringify({
      source: `${repo.owner}/${repo.repo}`,
      issues: data.issues.length,
      pullRequests: data.pullRequests.length,
      commits: data.commits.length,
      issueComments: [...data.issueComments.values()].reduce((s, c) => s + c.length, 0),
      prComments: [...data.prComments.values()].reduce((s, c) => s + c.length, 0),
      totalOps: allOps.length,
      rev: result.rev,
      status: result.status,
      elapsedSeconds: parseFloat(elapsed),
    }, null, 2));
  } else {
    console.log(chalk.bold("\nGitHub ingest summary"));
    console.log(`  repo:            ${repo.owner}/${repo.repo}`);
    console.log(`  issues:          ${data.issues.length}`);
    console.log(`  pull requests:   ${data.pullRequests.length}`);
    console.log(`  commits:         ${data.commits.length}`);
    const issueCommentCount = [...data.issueComments.values()].reduce((s, c) => s + c.length, 0);
    const prCommentCount = [...data.prComments.values()].reduce((s, c) => s + c.length, 0);
    if (issueCommentCount > 0) console.log(`  issue comments:  ${issueCommentCount}`);
    if (prCommentCount > 0) console.log(`  PR comments:     ${prCommentCount}`);
    console.log(`  total ops:       ${allOps.length}`);
    console.log(`  rev:             ${result.rev}`);
    console.log(`  elapsed:         ${elapsed}s`);
    console.log();
  }
}
