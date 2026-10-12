// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import * as nodePath from "node:path";
import { renderSection, renderKeyValue, renderWarning, renderNote, renderSuccess } from "../ui.js";
import { createClient } from "../../client/factory.js";
import { canonicalWorkspacePath, getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { llmError, llmLine, printLlmLines } from "../llm.js";
import { backendUnreachableError, CliUsageError, isBackendUnreachable } from "../errors.js";
import { printJson } from "../format.js";
import { normalizePathSeparators } from "../path-match.js";
import {
  DEFAULT_VERIFY_SAMPLE,
  DEFAULT_VERIFY_SEED,
  runVerify,
  type VerifyFileResult,
  type VerifyReport,
} from "../verify.js";

/**
 * `ix verify --format llm`: one `verify` record with the verdict and the fix,
 * then one `file` record per file that is not clean. Clean files are counted,
 * not listed: on a healthy graph the answer is one line.
 */
export function renderVerifyLlm(report: VerifyReport): string[] {
  const lines = [llmLine("verify", [
    ["graph", report.graph],
    ["reason", report.reason ?? null],
    ["files", report.counts.files],
    ["clean", report.counts.clean],
    ["stale", report.counts.stale],
    ["diverged", report.counts.diverged],
    ["unverified", report.counts.unverified],
    ["fix", report.fix],
  ])];
  for (const f of report.files) {
    if (f.state === "clean") continue;
    lines.push(llmLine("file", [
      ["path", f.path],
      ["state", f.state],
      ["reason", f.reason ?? null],
      ["missing", f.missing.length],
      ["extra", f.extra.length],
      ["changed", f.changed.length],
    ]));
  }
  return lines;
}

function describeFile(f: VerifyFileResult): string {
  const parts: string[] = [f.state];
  if (f.reason) parts.push(f.reason.replace(/_/g, " "));
  if (f.missing.length > 0) parts.push(`${f.missing.length} missing`);
  if (f.extra.length > 0) parts.push(`${f.extra.length} extra`);
  if (f.changed.length > 0) parts.push(`${f.changed.length} changed`);
  return parts.join(", ");
}

function renderVerifyText(report: VerifyReport): void {
  renderSection("Verify");
  renderKeyValue("Graph", report.graph);
  if (report.reason) renderKeyValue("Reason", report.reason.replace(/_/g, " "));
  const c = report.counts;
  renderKeyValue("Files", `${c.files} checked: ${c.clean} clean, ${c.stale} stale, ${c.diverged} diverged, ${c.unverified} unverified`);
  for (const f of report.files) {
    if (f.state === "clean") continue;
    console.log(`    ${f.path} — ${describeFile(f)}`);
  }
  if (report.graph === "diverged") {
    renderWarning(`${c.diverged} file(s) hold nodes that do not match their own source. Fix: ${report.fix}`);
  } else if (report.graph === "unverified") {
    renderNote(report.fix ? `Not verified. Run ${report.fix} first.` : "Not verified: nothing could be compared.");
  } else if (c.stale > 0) {
    renderNote(`${c.stale} file(s) changed since the last ingest. Run ${report.fix} to update.`);
  } else {
    renderSuccess("Every checked file's nodes match a re-parse.");
  }
  // Said every time, so a clean verdict is not read as covering edges.
  renderNote("Nodes only: edges are not compared yet.");
}

function parseCount(flag: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const normalized = String(value).trim();
  const n = /^\+?\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new CliUsageError(
      `option '${flag}' must be ${min > 0 ? "a positive" : "a non-negative"} integer, got '${value}'.`,
      `For example: ix verify ${flag} ${min > 0 ? DEFAULT_VERIFY_SAMPLE : DEFAULT_VERIFY_SEED}`,
    );
  }
  return n;
}

/** A path the caller typed, as the workspace-relative POSIX path the graph stores. */
function toWorkspaceRel(root: string, input: string): string {
  // Canonical like the root, so a path typed through a symlink still lands inside it.
  const rel = normalizePathSeparators(nodePath.relative(root, canonicalWorkspacePath(nodePath.resolve(process.cwd(), input))));
  if (rel === "" || rel === ".." || rel.startsWith("../") || nodePath.isAbsolute(rel)) {
    throw new CliUsageError(`'${input}' is not a file inside the workspace at ${root}.`);
  }
  return rel;
}

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify [paths...]")
    .description("Compare the graph's nodes to a fresh re-parse of a sample of files")
    .option("--sample <n>", `How many files to check (default ${DEFAULT_VERIFY_SAMPLE}, or the number of paths given)`)
    .option("--seed <n>", `Seed for the random part of the sample (default ${DEFAULT_VERIFY_SEED})`)
    .option("--root <dir>", "Workspace root directory")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (paths: string[] | undefined, opts: { format: string; root?: string; sample?: string; seed?: string }) => {
      const named = paths ?? [];
      const sample = parseCount("--sample", opts.sample, named.length > 0 ? named.length : DEFAULT_VERIFY_SAMPLE, 1);
      const seed = parseCount("--seed", opts.seed, DEFAULT_VERIFY_SEED, 0);
      // Canonical, as ingest records it: `--root .`, `--root dir/` and a
      // symlinked or registered non-canonical path all name the same root.
      const root = canonicalWorkspacePath(resolveWorkspaceRoot(opts.root ? nodePath.resolve(opts.root) : undefined));
      const explicit = named.map((p) => toWorkspaceRel(root, p));
      const client = createClient();
      let report: VerifyReport;
      try {
        report = await runVerify(client, root, { sample, seed, paths: explicit });
      } catch (err) {
        // As `ix status` does: only a transport failure is "not reachable";
        // anything else reaches the shared boundary in errors.ts.
        if (!isBackendUnreachable(err)) throw err;
        const unreachable = backendUnreachableError(getEndpoint());
        if (opts.format === "llm") {
          console.log(llmError(unreachable.error, unreachable.message, [["hint", unreachable.next ?? null]]));
        } else {
          console.error(unreachable.message);
          if (unreachable.next) console.error(unreachable.next);
        }
        process.exit(1);
      }

      // Exit 0 for every verdict: diverged is an answer, not a failure to run.
      if (opts.format === "llm") {
        printLlmLines(renderVerifyLlm(report));
      } else if (opts.format === "json") {
        printJson(report);
      } else {
        renderVerifyText(report);
      }
    });
}
