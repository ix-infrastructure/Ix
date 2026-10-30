// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { printJson } from "../format.js";
import { llmError, printLlmLines } from "../llm.js";
import { parseBudgetOption } from "../options.js";
import { setOutcome } from "../outcome.js";
import { isQuiet } from "../output-shape.js";
import { stderr } from "../stderr.js";
import { SourceFiles } from "../edge-sites.js";
import { canonicalPath } from "../hook/session.js";
import {
  AroundError, DEFAULT_CAPS, DEFAULT_TOKEN_BUDGET, fitToBudget, gatherAround, parseAroundTarget,
  type AroundCaps, type AroundResult,
} from "../around.js";
import { aroundJson, renderAroundLlm, renderAroundText } from "../around-render.js";

export function reportError(code: string, message: string, format: string, extra: Array<[string, string]> = []): void {
  if (format === "json") printJson({ error: code, message, ...Object.fromEntries(extra) });
  else if (format === "llm") console.log(llmError(code, message, extra));
  else stderr(chalk.red(message));
  // A file that is not in the graph is a miss (3), as for every graph command
  // that resolves a target (outcome.ts); a bad argument is an error (1).
  if (code === "unresolved_target") setOutcome("not_found");
  else process.exitCode = 1;
}

/** The file's lines, or none when it is not on disk (the graph's spans then stand as recorded). */
export function readLines(abs: string): string[] {
  try {
    // One descriptor for the checks and the read, so the file measured is the
    // file read (CodeQL js/file-system-race).
    const fd = fs.openSync(abs, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return [];
      return fs.readFileSync(fd, "utf-8").split("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** A path relative to the workspace root first, then to the cwd; absolute as given. */
export function resolveAroundFile(file: string, root: string, cwd = process.cwd()): string {
  if (path.isAbsolute(file)) return path.resolve(file);
  const fromRoot = path.resolve(root, file);
  if (fs.existsSync(fromRoot)) return fromRoot;
  const fromCwd = path.resolve(cwd, file);
  return fs.existsSync(fromCwd) ? fromCwd : fromRoot;
}

/**
 * `abs` relative to the workspace root, `/`-separated, or undefined when it is
 * outside it. Both sides in their canonical spelling: an absolute path through
 * a link (macOS's /tmp, a symlinked checkout) names a file inside a root
 * registered under the other spelling.
 */
export function aroundRelPath(abs: string, root: string): string | undefined {
  const rel = path.relative(canonicalPath(root), canonicalPath(abs)).split(path.sep).join("/");
  return rel.startsWith("..") || path.isAbsolute(rel) ? undefined : rel;
}

/**
 * `--limit`: digits are the row count (0 for all). Anything else falls back as
 * it always has (`abc` to the default, `-1` to 1) rather than failing, so a
 * runner passing a bad value keeps its exit status.
 */
export function limitOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Math.max(1, parseInt(raw, 10) || DEFAULT_CAPS.callers);
}

export function capsFor(limit?: number, format = "text"): AroundCaps {
  if (limit === undefined && format !== "json") return { ...DEFAULT_CAPS };
  const rows = limit === undefined || limit === 0 ? Infinity : limit;
  return {
    ...DEFAULT_CAPS,
    callers: rows,
    users: rows,
    tests: rows,
    importers: rows,
  };
}

export function registerAroundCommand(program: Command): void {
  program
    .command("around <target>")
    .description("Show who depends on the code at a file location: callers, importers, tests")
    .option("--limit <n>", "Max rows per list; 0 for all (text/llm default: 8 callers, 5 others; json: all)")
    .option("--budget <tokens>", `Token budget for text/llm output (~4 chars a token)`, (v: string) => parseBudgetOption(v, String(DEFAULT_TOKEN_BUDGET)), DEFAULT_TOKEN_BUDGET)
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `
<target> is path[:line[-end]], relative to the workspace root or absolute.
With a line, reports the definitions whose span covers it (innermost first);
without one, the file's most-called top-level definitions. At most 3 symbols.

Examples:
  ix around src/cli/options.ts:109
  ix around src/cli/options.ts:100-140 --format llm
  ix around src/cli/config.ts --limit 3`)
    .action(async (target: string, opts: { limit?: string; budget: number; format: string }) => {
      const parsed = parseAroundTarget(target);
      if (!parsed) {
        reportError("invalid_line_range", `Invalid target "${target}". Use path, path:line or path:start-end (1-based).`, opts.format);
        return;
      }
      const root = resolveWorkspaceRoot();
      const abs = resolveAroundFile(parsed.file, root);
      const relPath = aroundRelPath(abs, root);
      if (relPath === undefined) {
        reportError("path_outside_workspace", `${abs} is outside the workspace root ${root}.`, opts.format);
        return;
      }
      const lines = readLines(abs);
      const caps = capsFor(limitOption(opts.limit), opts.format);
      const client = createClient();

      let result: AroundResult;
      try {
        result = await gatherAround(client, {
          relPath,
          ranges: parsed.range ? [parsed.range] : undefined,
          anchorLines: lines,
          files: new SourceFiles(root),
          caps,
          heuristicTests: true,
        });
      } catch (err) {
        if (err instanceof AroundError) {
          const onDisk = lines.length > 0;
          const reason = onDisk ? "file_not_in_graph" : "file_not_found";
          const message = onDisk
            ? `"${relPath}" exists on disk but is not in the graph: it has not been mapped yet (run \`ix map\`), or Ix does not parse it.`
            : `No file "${relPath}" in the graph, and none at that path on disk.`;
          reportError("unresolved_target", message, opts.format, [["reason", reason]]);
          return;
        }
        throw err;
      }
      if (parsed.range) result.lines = { start: parsed.range.start, end: parsed.range.end };

      if (opts.format === "json") {
        printJson(aroundJson(result));
        return;
      }
      if (opts.format === "llm") {
        const fitted = fitToBudget(result, (r) => renderAroundLlm(r).join("\n"), opts.budget, caps);
        printLlmLines(renderAroundLlm(fitted));
        return;
      }
      const textOpts = { importerRows: !isQuiet() };
      const fitted = fitToBudget(result, (r) => renderAroundText(r, textOpts), opts.budget, caps);
      console.log(renderAroundText(fitted, textOpts));
    });
}
