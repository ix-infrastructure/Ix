import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, resolveEntityFull, printResolved, looksFileLike, type ResolvedEntity } from "../resolve.js";
import { formatDiff, relativePath, stripNulls } from "../format.js";
import { stderr } from "../stderr.js";

const execFileAsync = promisify(execFile);

// ── Line-level diff (legacy, kept for backward compat) ─────────────

/** Simple sequential line diff producing `+ `, `- `, `  ` prefixed lines. */
export function computeLineDiff(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const result: string[] = [];
  const maxLen = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLen; i++) {
    const bLine = i < beforeLines.length ? beforeLines[i] : undefined;
    const aLine = i < afterLines.length ? afterLines[i] : undefined;

    if (bLine === aLine) {
      result.push(`  ${bLine}`);
    } else {
      if (bLine !== undefined) result.push(`- ${bLine}`);
      if (aLine !== undefined) result.push(`+ ${aLine}`);
    }
  }

  return result;
}

// ── JSON compaction ────────────────────────────────────────────────

/** Compact a node snapshot from a diff change — drop timestamps, null deletedRev, member_files UUIDs. */
function compactNodeSnapshot(node: any): any {
  if (!node) return node;
  const out: any = { name: node.name, kind: node.kind };
  if (node.provenance) {
    const p = node.provenance;
    const uri = relativePath(p.source_uri ?? p.sourceUri);
    if (uri) out.path = uri;
    if (p.source_hash ?? p.sourceHash) out.hash = (p.source_hash ?? p.sourceHash).slice(0, 12);
  }
  if (node.attrs) {
    const a = { ...node.attrs };
    // Drop member_files UUID arrays (bulky, not useful in diff output)
    delete a.member_files;
    delete a.memberFiles;
    // Keep only non-empty attrs
    if (Object.keys(a).length > 0) out.attrs = a;
  }
  return out;
}

/** Compact a diff result — strip bloat from change snapshots. */
function compactDiffResult(result: any): any {
  const out: any = {
    fromRev: result.fromRev,
    toRev: result.toRev,
    total: result.total ?? result.totalChanges,
  };
  if (result.truncated) out.truncated = true;
  if (result.changes) {
    out.changes = result.changes.map((c: any) => {
      const change: any = { changeType: c.changeType };
      if (c.atFromRev) change.from = compactNodeSnapshot(c.atFromRev);
      if (c.atToRev) change.to = compactNodeSnapshot(c.atToRev);
      // Preserve source content fields added by --content fallback
      if (c.sourceContentBefore !== undefined) change.sourceContentBefore = c.sourceContentBefore;
      if (c.sourceContentAfter !== undefined) change.sourceContentAfter = c.sourceContentAfter;
      if (c.sourceDiff !== undefined) change.sourceDiff = c.sourceDiff;
      if (c.sourceContent !== undefined) change.sourceContent = c.sourceContent;
      return change;
    });
  }
  if (result.summary) out.summary = result.summary;
  return out;
}

// ── File content loading ────────────────────────────────────────────

/** Load full file content from current disk. */
export function loadFileFromDisk(uri: string): string | null {
  const filePath = path.resolve(uri);
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load full file content at a specific timestamp via git.
 * Returns null if git fails or file doesn't exist at that point.
 */
export async function loadFileAtTimestamp(uri: string, timestamp: string): Promise<string | null> {
  const relPath = uri;
  try {
    const { stdout: commitHash } = await execFileAsync("git", [
      "log", "-1", "--format=%H", `--before=${timestamp}`, "--", relPath,
    ], { timeout: 10_000 });
    const hash = commitHash.trim();
    if (!hash) return null;
    const { stdout: fileContent } = await execFileAsync("git", [
      "show", `${hash}:${relPath}`,
    ], { timeout: 10_000 });
    return fileContent;
  } catch {
    return null;
  }
}

/**
 * Get the timestamp for a specific graph revision by scanning the patch list.
 * Falls back to current time if revision not found.
 */
async function getRevisionTimestamp(client: IxClient, rev: number): Promise<string | null> {
  try {
    const patches = await client.listPatches({ limit: 200 });
    // Find the patch at or closest to this revision
    const exact = patches.find((p: any) => p.rev === rev);
    if (exact?.timestamp) return exact.timestamp;
    // Find nearest rev <= target
    const earlier = patches
      .filter((p: any) => p.rev <= rev && p.timestamp)
      .sort((a: any, b: any) => b.rev - a.rev);
    if (earlier.length > 0) return (earlier[0] as any).timestamp;
    return null;
  } catch {
    return null;
  }
}

// ── Textual diff via git ────────────────────────────────────────────

/**
 * Compute a unified diff between two strings using git diff --no-index.
 * Returns parsed hunk lines (starting with @@, +, -, or space).
 * Returns empty array if contents are identical.
 */
export async function computeTextualDiff(
  before: string,
  after: string,
): Promise<string[]> {
  const tmpDir = os.tmpdir();
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const beforePath = path.join(tmpDir, `ix-diff-a-${ts}`);
  const afterPath = path.join(tmpDir, `ix-diff-b-${ts}`);
  fs.writeFileSync(beforePath, before);
  fs.writeFileSync(afterPath, after);

  try {
    await execFileAsync("git", [
      "diff", "--no-index", "--unified=3", "--no-color",
      "--", beforePath, afterPath,
    ], { timeout: 10_000 });
    // Exit code 0 = identical
    return [];
  } catch (err: any) {
    // Exit code 1 = files differ (normal for git diff --no-index)
    const stdout: string = err.stdout ?? "";
    if (!stdout) return [];
    return parseDiffOutput(stdout);
  } finally {
    try { fs.unlinkSync(beforePath); } catch {}
    try { fs.unlinkSync(afterPath); } catch {}
  }
}

/** Parse git diff output — keep only hunk headers and content lines. */
function parseDiffOutput(raw: string): string[] {
  const lines = raw.split("\n");
  const result: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      result.push(line);
    } else if (inHunk) {
      if (line.startsWith("diff ") || line.startsWith("index ") ||
          line.startsWith("--- ") || line.startsWith("+++ ") ||
          line.startsWith("\\ No newline")) {
        // New diff section or metadata — skip
        if (line.startsWith("diff ")) inHunk = false;
        continue;
      }
      result.push(line);
    }
  }
  return result;
}

/**
 * Slice textual diff hunks to only include lines within a line range.
 * Returns only hunks that overlap with [lineStart, lineEnd].
 */
function sliceHunksToSpan(diffLines: string[], lineStart: number, lineEnd: number): string[] {
  const result: string[] = [];
  let afterLineNo = 0;
  let inRange = false;

  for (const line of diffLines) {
    if (line.startsWith("@@")) {
      // Parse hunk header: @@ -a,b +c,d @@
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        afterLineNo = parseInt(match[1], 10);
        // Check if this hunk overlaps with our range
        inRange = false; // Will be set per-line
        continue;
      }
    }

    if (line.startsWith("+")) {
      if (afterLineNo >= lineStart && afterLineNo <= lineEnd) {
        if (!inRange) {
          result.push(`@@ line ${afterLineNo} @@`);
          inRange = true;
        }
        result.push(line);
      }
      afterLineNo++;
    } else if (line.startsWith("-")) {
      // Removed lines: if we're in range, include them
      if (afterLineNo >= lineStart && afterLineNo <= lineEnd + 1) {
        if (!inRange) {
          result.push(`@@ line ${afterLineNo} @@`);
          inRange = true;
        }
        result.push(line);
      }
    } else {
      // Context line
      if (afterLineNo >= lineStart && afterLineNo <= lineEnd) {
        if (inRange) {
          result.push(line);
        }
      } else {
        inRange = false;
      }
      afterLineNo++;
    }
  }
  return result;
}

// ── Source span reading (for graph-driven diff) ─────────────────────

/** Try to read source lines from disk using entity provenance and line spans. */
function readSourceSpan(node: any): string | null {
  if (!node) return null;
  const uri: string = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? "";
  if (!uri) return null;

  const attrs = node.attrs ?? {};
  const lineStart = attrs.line_start ?? attrs.lineStart;
  const lineEnd = attrs.line_end ?? attrs.lineEnd;
  if (lineStart == null || lineEnd == null) return null;

  const filePath = path.resolve(uri);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, Number(lineStart) - 1);
    const end = Math.min(lines.length, Number(lineEnd));
    if (start >= end) return null;
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}

/**
 * Read source span at a historical point in time using git.
 * Falls back to readSourceSpan (current disk) if git fails.
 */
export async function readSourceSpanAtTimestamp(node: any): Promise<string | null> {
  if (!node) return null;
  const uri: string = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? "";
  if (!uri) return null;

  const attrs = node.attrs ?? {};
  const lineStart = attrs.line_start ?? attrs.lineStart;
  const lineEnd = attrs.line_end ?? attrs.lineEnd;
  if (lineStart == null || lineEnd == null) return null;

  const timestamp = node.updatedAt ?? node.createdAt;
  if (!timestamp) return readSourceSpan(node);

  const relPath = uri;
  try {
    const { stdout: commitHash } = await execFileAsync("git", [
      "log", "-1", "--format=%H", `--before=${timestamp}`, "--", relPath,
    ], { timeout: 10_000 });
    const hash = commitHash.trim();
    if (!hash) return readSourceSpan(node);

    const { stdout: fileContent } = await execFileAsync("git", [
      "show", `${hash}:${relPath}`,
    ], { timeout: 10_000 });

    const lines = fileContent.split("\n");
    const start = Math.max(0, Number(lineStart) - 1);
    const end = Math.min(lines.length, Number(lineEnd));
    if (start >= end) return readSourceSpan(node);
    return lines.slice(start, end).join("\n");
  } catch {
    return readSourceSpan(node);
  }
}

// ── Get file URI from resolved entity or graph changes ──────────────

function getFileUri(resolved: ResolvedEntity | null, changes: any[]): string | null {
  // From resolved entity path
  if (resolved?.path) return resolved.path;

  // From graph changes provenance
  for (const c of changes) {
    const node = c.atToRev ?? c.atFromRev;
    const uri = node?.provenance?.source_uri ?? node?.provenance?.sourceUri;
    if (uri) return uri;
  }
  return null;
}

function getLineSpan(resolved: ResolvedEntity | null, changes: any[]): { start: number; end: number } | null {
  // Symbol targets (non-file kinds) have line spans
  if (resolved && resolved.kind !== "file") {
    for (const c of changes) {
      const node = c.atToRev ?? c.atFromRev;
      const attrs = node?.attrs ?? {};
      const lineStart = attrs.line_start ?? attrs.lineStart;
      const lineEnd = attrs.line_end ?? attrs.lineEnd;
      if (lineStart != null && lineEnd != null) {
        return { start: Number(lineStart), end: Number(lineEnd) };
      }
    }
  }
  return null;
}

/**
 * Get line spans for both before and after revisions of a symbol.
 * Returns null if the target is a file or spans can't be determined.
 */
function getSymbolSpans(resolved: ResolvedEntity | null, changes: any[]): {
  before: { start: number; end: number } | null;
  after: { start: number; end: number } | null;
} | null {
  if (!resolved || resolved.kind === "file") return null;

  let before: { start: number; end: number } | null = null;
  let after: { start: number; end: number } | null = null;

  for (const c of changes) {
    if (c.atFromRev) {
      const attrs = c.atFromRev.attrs ?? {};
      const ls = attrs.line_start ?? attrs.lineStart;
      const le = attrs.line_end ?? attrs.lineEnd;
      if (ls != null && le != null) before = { start: Number(ls), end: Number(le) };
    }
    if (c.atToRev) {
      const attrs = c.atToRev.attrs ?? {};
      const ls = attrs.line_start ?? attrs.lineStart;
      const le = attrs.line_end ?? attrs.lineEnd;
      if (ls != null && le != null) after = { start: Number(ls), end: Number(le) };
    }
  }

  if (!before && !after) return null;
  return { before, after };
}

/**
 * Extract a slice of lines from full file content.
 * lineStart and lineEnd are 1-based inclusive.
 */
function sliceContent(content: string, lineStart: number, lineEnd: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, lineStart - 1);
  const end = Math.min(lines.length, lineEnd);
  return lines.slice(start, end).join("\n");
}

// ── CLI command ─────────────────────────────────────────────────────

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <fromRev> <toRev> [target]")
    .description("Show diff between two revisions, optionally scoped to a file or entity")
    .option("--entity <id>", "Filter by entity ID (deprecated, use positional target)")
    .option("--summary", "Show compact summary only (server-side, fast)")
    .option("--content", "Show detailed attribute changes for each entity")
    .option("--limit <n>", "Max changes to return (default 100)")
    .option("--full", "Return all changes (no limit)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .addHelpText("after", `\nExamples:
  ix diff 3 5
  ix diff 3 5 ix-cli/src/cli/commands/decide.ts
  ix diff 3 5 decide.ts --content
  ix diff 3 5 buildDecisionPatch --content --pick 1
  ix diff 3 5 --summary`)
    .action(async (fromRev: string, toRev: string, target: string | undefined, opts: {
      entity?: string; summary?: boolean; content?: boolean; limit?: string; full?: boolean; format: string;
      kind?: string; path?: string; pick?: string;
    }) => {
      const client = new IxClient(getEndpoint());
      const from = parseInt(fromRev, 10);
      const to = parseInt(toRev, 10);

      // Resolve the scope entity from positional target or --entity flag
      const resolveOpts = {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick ? parseInt(opts.pick, 10) : undefined,
      };
      let entityId: string | undefined = opts.entity;
      let resolved: ResolvedEntity | null = null;
      if (target && !entityId) {
        if (opts.format === "json") {
          // Use full resolver for structured JSON ambiguity output
          const allKinds = ["file", "class", "object", "trait", "interface", "module", "function", "method"];
          const isFile = looksFileLike(target);
          if (!isFile) {
            const fullResult = await resolveEntityFull(client, target, allKinds, resolveOpts);
            if (fullResult.resolved) {
              resolved = fullResult.entity;
            } else if (fullResult.ambiguous) {
              console.log(JSON.stringify(fullResult.result, null, 2));
              return;
            } else {
              console.log(JSON.stringify({ error: `No entity found matching "${target}".` }, null, 2));
              return;
            }
          } else {
            resolved = await resolveFileOrEntity(client, target, resolveOpts);
            if (!resolved) {
              console.log(JSON.stringify({ error: `No entity found matching "${target}".` }, null, 2));
              return;
            }
          }
        } else {
          resolved = await resolveFileOrEntity(client, target, resolveOpts);
          if (!resolved) return;
          printResolved(resolved);
        }
        entityId = resolved.id;
      }

      if (opts.summary) {
        const result: any = await client.diff(from, to, { summary: true, entityId });

        if (opts.format === "json") {
          console.log(JSON.stringify(compactDiffResult(result), null, 2));
        } else {
          const s = result.summary || {};
          console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
          if (s.added) console.log(`  ${chalk.green("Added:")}    ${s.added}`);
          if (s.modified) console.log(`  ${chalk.yellow("Modified:")} ${s.modified}`);
          if (s.removed) console.log(`  ${chalk.red("Removed:")}  ${s.removed}`);
          if (!s.added && !s.modified && !s.removed) console.log(chalk.dim("  No changes."));
          console.log(`  ${chalk.dim("Total:")}    ${result.total}`);
          console.log();
        }
        return;
      }

      const limit = opts.full ? undefined : (opts.limit ? parseInt(opts.limit, 10) : undefined);
      const result: any = await client.diff(from, to, { entityId, limit });
      const changes: any[] = result.changes ?? [];

      // ── Content mode: textual diff is primary ───────────────────────
      if (opts.content) {
        // Try to get file URI for textual diffing
        const fileUri = getFileUri(resolved, changes);

        if (fileUri) {
          // Load full file content at both revisions
          const beforeFile = await loadContentAtRev(client, fileUri, from, changes, "from");
          const afterFile = await loadContentAtRev(client, fileUri, to, changes, "to");

          if (beforeFile !== null && afterFile !== null) {
            const symbolSpans = getSymbolSpans(resolved, changes);
            let diffLines: string[];
            let diffMode: string;
            let displaySpan: { start: number; end: number } | null = null;

            if (symbolSpans) {
              // Symbol target: extract symbol body at each revision and diff those
              const beforeBody = symbolSpans.before
                ? sliceContent(beforeFile, symbolSpans.before.start, symbolSpans.before.end)
                : "";
              const afterBody = symbolSpans.after
                ? sliceContent(afterFile, symbolSpans.after.start, symbolSpans.after.end)
                : "";
              diffLines = await computeTextualDiff(beforeBody, afterBody);
              diffMode = "symbol";
              displaySpan = symbolSpans.after ?? symbolSpans.before;
            } else {
              // File target: diff the whole file
              diffLines = await computeTextualDiff(beforeFile, afterFile);
              diffMode = "file";
            }

            if (opts.format === "json") {
              const jsonResult: any = {
                ...compactDiffResult(result),
                textualDiff: diffLines,
                hasTextualChanges: diffLines.length > 0,
                diffMode,
              };
              if (displaySpan) {
                jsonResult.lineSpan = displaySpan;
              }
              console.log(JSON.stringify(jsonResult, null, 2));
            } else {
              console.log(chalk.cyan.bold(`\nDiff: rev ${from} → ${to}`));
              if (diffLines.length === 0) {
                console.log(chalk.dim("  No textual changes detected."));
              } else {
                console.log(`  ${chalk.dim("file:")} ${fileUri}`);
                if (displaySpan) {
                  console.log(`  ${chalk.dim(`scoped to lines ${displaySpan.start}-${displaySpan.end}`)}`);
                }
                console.log();
                for (const line of diffLines) {
                  if (line.startsWith("@@")) {
                    console.log(`  ${chalk.cyan(line)}`);
                  } else if (line.startsWith("+")) {
                    console.log(`  ${chalk.green(line)}`);
                  } else if (line.startsWith("-")) {
                    console.log(`  ${chalk.red(line)}`);
                  } else {
                    console.log(`  ${line}`);
                  }
                }
              }

              // Also show graph-level changes if any
              if (changes.length > 0) {
                console.log(chalk.dim(`\n  Graph changes: ${changes.length}`));
                for (const c of changes) {
                  const name = c.atToRev?.name ?? c.atFromRev?.name ?? "?";
                  const kind = c.atToRev?.kind ?? c.atFromRev?.kind ?? "unknown";
                  const typeChar = c.changeType === "added" ? "+" : c.changeType === "removed" ? "-" : "~";
                  console.log(`    ${chalk.dim(typeChar)} ${chalk.dim(kind)} ${chalk.dim(name)}`);
                }
              }
              console.log();
            }
            return;
          }
        }

        // Fallback: graph-driven content diff (no file URI or git failed)
        if (opts.format === "json") {
          for (const c of changes) {
            const beforeSource = await readSourceSpanAtTimestamp(c.atFromRev);
            const afterSource = readSourceSpan(c.atToRev);
            if (beforeSource !== null) c.sourceContentBefore = beforeSource;
            if (afterSource !== null) c.sourceContentAfter = afterSource;
            if (beforeSource !== null && afterSource !== null) {
              c.sourceDiff = await computeTextualDiff(beforeSource, afterSource);
            } else if (beforeSource !== null || afterSource !== null) {
              c.sourceContent = afterSource ?? beforeSource;
            }
          }
          console.log(JSON.stringify(compactDiffResult(result), null, 2));
        } else {
          await formatDiffContent(result);
        }
        return;
      }

      // ── Non-content mode ────────────────────────────────────────────
      // If target is a file/symbol and graph shows no changes,
      // check for textual changes as a supplementary signal.
      if (resolved && changes.length === 0) {
        const fileUri = getFileUri(resolved, changes) ?? resolved.path;
        if (fileUri) {
          const beforeContent = await loadContentAtRev(client, fileUri, from, changes, "from");
          const afterContent = await loadContentAtRev(client, fileUri, to, changes, "to");

          if (beforeContent !== null && afterContent !== null && beforeContent !== afterContent) {
            const diffLines = await computeTextualDiff(beforeContent, afterContent);
            const changeCount = diffLines.filter(l => l.startsWith("+") || l.startsWith("-")).length;

            if (opts.format === "json") {
              console.log(JSON.stringify({
                ...compactDiffResult(result),
                textualChanges: {
                  detected: true,
                  lineChanges: changeCount,
                  note: "Textual changes detected but not captured by graph parser (e.g. comments, whitespace).",
                },
              }, null, 2));
            } else {
              const name = resolved.name ?? fileUri;
              console.log(chalk.yellow(`${name} modified (${changeCount} textual changes — not captured by parser)`));
              console.log(chalk.dim("  Use --content to see full diff."));
            }
            return;
          }
        }
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(compactDiffResult(result), null, 2));
      } else {
        if (result.truncated) {
          console.log(chalk.yellow(`Showing ${result.changes.length} of ${result.totalChanges} changes. Use --full to see all.\n`));
        }
        formatDiff(result, "text");
      }
    });
}

/**
 * Resolve the "before" timestamp for textual diffing.
 * Tries: graph change snapshots → patch list → null.
 */
async function resolveFromTimestamp(
  client: IxClient,
  fromRev: number,
  changes: any[],
): Promise<string | null> {
  // Try to get timestamp from graph change snapshots
  for (const c of changes) {
    const ts = c.atFromRev?.updatedAt ?? c.atFromRev?.createdAt;
    if (ts) return ts;
  }
  // Fall back to patch list
  return getRevisionTimestamp(client, fromRev);
}

/**
 * Resolve the "after" timestamp for textual diffing.
 * Tries: graph change snapshots → patch list → null.
 * Returns null if toRev is the latest revision (caller should use disk).
 */
async function resolveToTimestamp(
  client: IxClient,
  toRev: number,
  changes: any[],
): Promise<string | null> {
  // Check if toRev is the latest revision
  try {
    const patches = await client.listPatches({ limit: 1 });
    if (patches.length > 0 && (patches[0] as any).rev === toRev) {
      return null; // Latest rev — use disk
    }
  } catch {}
  // Try to get timestamp from graph change snapshots
  for (const c of changes) {
    const ts = c.atToRev?.updatedAt ?? c.atToRev?.createdAt;
    if (ts) return ts;
  }
  // Fall back to patch list
  return getRevisionTimestamp(client, toRev);
}

/**
 * Load file content for a specific revision.
 * Uses disk for latest revision, git for historical revisions.
 */
async function loadContentAtRev(
  client: IxClient,
  fileUri: string,
  rev: number,
  changes: any[],
  side: "from" | "to",
): Promise<string | null> {
  if (side === "from") {
    const ts = await resolveFromTimestamp(client, rev, changes);
    return ts ? loadFileAtTimestamp(fileUri, ts) : loadFileFromDisk(fileUri);
  } else {
    const ts = await resolveToTimestamp(client, rev, changes);
    // null timestamp = latest rev = use disk
    return ts ? loadFileAtTimestamp(fileUri, ts) : loadFileFromDisk(fileUri);
  }
}

// ── Graph-driven content display (fallback) ─────────────────────────

/** Render detailed attribute-level changes with source code for each entity. */
async function formatDiffContent(result: any): Promise<void> {
  console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
  const changes = result.changes ?? [];
  if (changes.length === 0) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }

  for (const c of changes) {
    const before = c.atFromRev;
    const after = c.atToRev;
    const name = after?.name ?? before?.name ?? c.entityId?.substring(0, 8) ?? "?";
    const kind = after?.kind ?? before?.kind ?? "unknown";
    const typeChar = c.changeType === "added" ? "+" : c.changeType === "removed" ? "-" : "~";
    const typeColor = c.changeType === "added" ? chalk.green : c.changeType === "removed" ? chalk.red : chalk.yellow;

    console.log(`\n${typeColor(typeChar)} ${chalk.cyan(kind)} ${chalk.bold(name)}`);

    const activeNode = after ?? before;
    const uri = activeNode?.provenance?.source_uri ?? activeNode?.provenance?.sourceUri ?? "";
    if (uri) console.log(`  ${chalk.dim("file:")} ${uri}`);

    if (c.changeType === "added" && after) {
      printAttrs("  ", after.attrs);
    } else if (c.changeType === "modified" && before && after) {
      diffAttrs("  ", before.attrs ?? {}, after.attrs ?? {});
    }

    // Textual diff using git for historical before content
    const beforeSource = await readSourceSpanAtTimestamp(before);
    const afterSource = readSourceSpan(after);
    if (beforeSource !== null && afterSource !== null && c.changeType === "modified") {
      const diffLines = await computeTextualDiff(beforeSource, afterSource);
      if (diffLines.length > 0) {
        console.log(`  ${chalk.dim("source diff:")}`);
        for (const line of diffLines) {
          if (line.startsWith("@@")) {
            console.log(`  ${chalk.dim("│")} ${chalk.cyan(line)}`);
          } else if (line.startsWith("+")) {
            console.log(`  ${chalk.dim("│")} ${chalk.green(line)}`);
          } else if (line.startsWith("-")) {
            console.log(`  ${chalk.dim("│")} ${chalk.red(line)}`);
          } else {
            console.log(`  ${chalk.dim("│")} ${line}`);
          }
        }
      } else {
        console.log(`  ${chalk.dim("(no textual changes in source span)")}`);
      }
    } else {
      // Single-revision fallback
      const source = readSourceSpan(activeNode);
      if (source) {
        const lineStart = (activeNode.attrs?.line_start ?? activeNode.attrs?.lineStart) || "?";
        console.log(`  ${chalk.dim(`source (L${lineStart}):`)} `);
        for (const line of source.split("\n")) {
          console.log(`  ${chalk.dim("│")} ${line}`);
        }
      }
    }
  }
  console.log();
}

function printAttrs(indent: string, attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined) continue;
    const display = typeof val === "string" ? val : JSON.stringify(val);
    console.log(`${indent}${chalk.dim(key + ":")} ${display}`);
  }
}

function diffAttrs(indent: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const bVal = before[key];
    const aVal = after[key];
    if (bVal === undefined && aVal !== undefined) {
      const display = typeof aVal === "string" ? aVal : JSON.stringify(aVal);
      console.log(`${indent}${chalk.green("+")} ${chalk.dim(key + ":")} ${display}`);
    } else if (bVal !== undefined && aVal === undefined) {
      const display = typeof bVal === "string" ? bVal : JSON.stringify(bVal);
      console.log(`${indent}${chalk.red("-")} ${chalk.dim(key + ":")} ${display}`);
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      const bDisplay = typeof bVal === "string" ? bVal : JSON.stringify(bVal);
      const aDisplay = typeof aVal === "string" ? aVal : JSON.stringify(aVal);
      console.log(`${indent}${chalk.yellow("~")} ${chalk.dim(key + ":")} ${chalk.red(String(bDisplay))} → ${chalk.green(String(aDisplay))}`);
    }
  }
}
