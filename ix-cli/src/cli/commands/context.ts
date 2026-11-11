// Copyright 2026 Ix Infrastructure Inc.

// `ix context`: flag registration and mode dispatch. The work lives in
// `../context/`: options, saved investigations, issue mode, bundle assembly,
// ranking, rendering and next-step planning.

import type { Command } from "commander";
import { dirname, join, resolve } from "node:path";

import { BUNDLE_SCHEMA, contextBundleSchema } from "../context-bundle-schema.js";
import { createClient } from "../../client/factory.js";
import { saveBm25Index } from "../explain/bm25-cache.js";
import { formatOption, kindOption, parseRevisionOption, pathOption, pickOption, strictOption } from "../options.js";
import {
  activeReadScope,
  resolveFileOrReport,
  type ResolutionNotice,
} from "../resolve.js";
import { hasCompletedSourceGraphBaseline } from "../stale.js";
import { renderNote, renderWarningErr, reportFailure } from "../ui.js";
import { takeResolutionNotices } from "../format.js";
import { checkGraphHealth } from "../graph-health.js";

import { buildBundle } from "../context/bundle.js";
import { collectContextFacts, bundleGraphHealth } from "../context/collect.js";
import { buildFreshBundle, renderInvestigationDiff } from "../context/investigation-diff.js";
import {
  saveInvestigation,
  mergeDiffOptions,
  listInvestigations,
  renderInvestigationList,
  loadInvestigation,
  renderSavedInvestigation,
} from "../context/investigations.js";
import { buildIssueBundle, emitLeanIssue } from "../context/issue.js";
import {
  budgetHelp,
  budgetField,
  budgetParser,
  type BundleFormat,
  bundleFormat,
  clampBudgets,
  type ContextOptions,
  CONTEXT_DEPTHS,
  parseContextDepthOption,
  detectContextModeConflict,
  parseRequestedBudgets,
} from "../context/options.js";
import { renderBundle } from "../context/render.js";
import type { ContextBundle } from "../context/types.js";

/**
 * Build a bounded, deterministic context bundle for one target.
 *
 * This composes Ix's existing intelligence rather than re-deriving it: the
 * target is resolved through the same resolver as `ix explain`, structural
 * facts come from the same collector, and claims/conflicts/decisions/intents
 * come from the same `/v1/context` service. The only new thing here is the
 * bundling, budgeting, and deterministic ranking.
 */
export function registerContextCommand(program: Command): void {
  program
    .command("context [target]")
    .description(
      "Build a bounded, deterministic context bundle for a symbol, file, or entity (or resume/diff a saved investigation without a target)",
    )
    .option(
      "--from-issue <file>",
      "Start from an issue or bug report instead of a target: a file, or - for stdin",
    )
    .option(
      "--lean",
      "With --from-issue: only the starting points Ix trusts and the next few files, or one line saying it trusts none",
    )
    .addOption(kindOption())
    .addOption(pathOption())
    .addOption(pickOption())
    .addOption(strictOption())
    .option(
      "--depth <depth>",
      `Context-graph expansion depth (${CONTEXT_DEPTHS.join("|")})`,
      parseContextDepthOption,
    )
    .option("--as-of-rev <n>", "Historical context as of a graph revision", parseRevisionOption)
    // No Commander default on the --max-* flags, so `parseRequestedBudgets`
    // can tell an absent flag from one set to the default value. The defaults
    // and ranges are the BUDGETS table's, applied by `clampBudgets` and shown
    // in the help text by `budgetHelp` -- they differ per flag, so there is no
    // single pair to name here.
    .option("--max-entities <n>", budgetHelp("maxEntities"), budgetParser("maxEntities"))
    .option("--max-relationships <n>", budgetHelp("maxRelationships"), budgetParser("maxRelationships"))
    .option("--max-evidence <n>", budgetHelp("maxEvidence"), budgetParser("maxEvidence"))
    .option("--max-tokens <n>", budgetHelp("maxTokens"), budgetParser("maxTokens"))
    // Not `budgetHelp`: there is no independent default to name any more. The
    // character budget is derived from `--max-tokens` unless this flag is
    // passed, and printing "(default: 12000)" beside a flag whose absence
    // produces 3,210 would be the kind of drift the BUDGETS table exists to
    // stop.
    .option(
      "--max-chars <n>",
      `${budgetField("maxChars").help} (overrides --max-tokens; clamped to ${budgetField("maxChars").min}-${budgetField("maxChars").max})`,
      budgetParser("maxChars"),
    )
    .addOption(formatOption())
    .option("--out <path>", "Write the JSON bundle to this file instead of stdout")
    .option("--save <id>", "Persist the bundle as a resumable investigation state")
    .option("--resume <id>", "Render a saved investigation state without a backend")
    .option("--diff <id>", "Diff a saved investigation against a fresh build of the same target")
    .option("--list", "List saved investigations (no target, no backend)")
    .addHelpText(
      "after",
      "\nExamples:\n  ix context IngestionService\n  ix context src/main.ts --format json\n  ix context --from-issue issue.md --format llm\n  gh issue view 123 --json body -q .body | ix context --from-issue -\n  ix context Widget --max-entities 20 --max-evidence 10\n  ix context Widget --save widget-investigation\n  ix context --resume widget-investigation\n  ix context --diff widget-investigation\n  ix context --list",
    )
    .action((target: string | undefined, opts: ContextOptions) => runContext(target, opts));
}

/** The `ix context` action: refuse conflicting flags, then run the one mode asked for. */
async function runContext(target: string | undefined, opts: ContextOptions): Promise<void> {
  const conflict = detectContextModeConflict(opts, target);
  if (conflict) {
    reportFailure("mode_conflict", conflict, opts.format);
    return;
  }
  // The output the evidence budget is charged against; --out writes JSON.
  const fmt = opts.out ? "json" : bundleFormat(opts.format);
  if (opts.resume) {
    renderSavedInvestigation(opts.resume, opts.format);
    return;
  }
  if (opts.list) {
    // No guard of its own: every combination it used to check is refused
    // above, before any mode branch can return first. The old one lived
    // here, below `if (opts.resume)`, so its `--resume` arm was dead.
    const listed = listInvestigations();
    renderInvestigationList(listed.saved, listed.skipped, opts.format);
    return;
  }
  if (opts.diff) {
    await runDiff(opts.diff, target, opts);
    return;
  }
  // The BM25 index is written once the answer is out (planIssueWith).
  if (opts.fromIssue && opts.lean) {
    try {
      await emitLeanIssue(opts.fromIssue, opts);
    } finally {
      saveBm25Index();
    }
    return;
  }
  if (opts.fromIssue) {
    try {
      const bundle = await buildIssueBundle(opts.fromIssue, opts, clampBudgets(opts, fmt), fmt);
      if (bundle) await emitBundle(bundle, opts);
    } finally {
      saveBm25Index();
    }
    return;
  }
  if (!target) {
    // An error with a non-zero status, not a stdout warning with a zero one:
    // a script asked for a bundle and got none, and a `--format llm` caller
    // got a prose line in the middle of a record stream saying so.
    reportFailure(
      "missing_target",
      "ix context requires a target unless --from-issue <file>, --resume <id>, --diff <id> or --list is given.",
      opts.format,
    );
    return;
  }

  await emitTargetBundle(target, opts, fmt);
}

/** `--diff <id>`: the saved investigation against a fresh build of the same target. */
async function runDiff(id: string, target: string | undefined, opts: ContextOptions): Promise<void> {
  const saved = loadInvestigation(id, opts.format);
  if (!saved) return;
  if (saved.bundle.issue && !target) {
    // The fresh side would be `ix context <centre>`: a named-target
    // bundle without the issue's rows, so every diff would report them
    // removed. The issue's text is not saved, so it cannot be rebuilt.
    reportFailure(
      "diff_unsupported",
      `Investigation "${id}" was built with --from-issue, and --diff can only rebuild a bundle from a named target. Run ix context --resume ${id} to see it, or build it again with --from-issue.`,
      opts.format,
    );
    return;
  }
  // The fresh side of --diff is built with the saved investigation's own
  // budgets, the argument to `buildFreshBundle` below, so any --max-*
  // flags the caller passed are not applied to it. Captured here so the
  // diff output can report what was asked for instead of dropping it
  // silently; what actually governed is read back off the built bundle.
  const requestedBudgets = parseRequestedBudgets(opts);
  // With no target or selector typed, the fresh side is the saved
  // bundle's own entity, looked up by its id: a name the save answered
  // for an auto-picked candidate (resolve.ts answerAmbiguous) is still
  // ambiguous, and re-resolving it strictly would exit 2.
  const reuseSavedEntity = !target && opts.kind === undefined && opts.path === undefined && opts.pick === undefined;
  const fresh = await buildFreshBundle(
    target ?? saved.bundle.target.name,
    { ...opts, ...mergeDiffOptions(saved, opts) },
    saved.bundle.budgets,
    opts.format,
    reuseSavedEntity ? saved.bundle.target.id : undefined,
  );
  if (!fresh) return;
  renderInvestigationDiff(saved, fresh, opts.format, requestedBudgets);
  return;
}

/** `ix context <target>`: resolve it, collect its facts and context, and emit the bundle. */
async function emitTargetBundle(target: string, opts: ContextOptions, fmt: BundleFormat): Promise<void> {
  const client = createClient({ query: true });

  const resolved = await resolveFileOrReport(client, target, {
    kind: opts.kind,
    path: opts.path,
    pick: opts.pick,
    strict: opts.strict,
    // --out / --save promise a bundle: a text-only name has none to
    // write, so it stays the miss (exit 3) rather than a file list and 0.
    ...(opts.out || opts.save ? { textAnswer: false } : {}),
  }, opts.format);
  if (!resolved) return;

  const budgets = clampBudgets(opts, fmt);
  const asOfRev = opts.asOfRev;

  const [facts, context, workspaceHealth] = await Promise.all([
    // Also carries the provenance response: `collectFacts` needs it for the
    // history length, and fetching it again here doubled one of the
    // slowest calls the command makes (~1.3s on the Ix repo's graph).
    collectContextFacts(client, resolved),
    // By id, not by name. Seeding by name makes the backend re-run the
    // search the resolver just did, and it can land on a different node of
    // the same name. Every call site must use it (this one, `buildFreshBundle`
    // in context/investigation-diff.ts and `--from-issue` in context/issue.ts;
    // context-seeds-by-id.test.ts counts them): converting only one makes
    // `--diff` compare a by-id bundle against a by-name one and report the
    // whole graph as changed.
    client.contextForNode(resolved.id, {
      asOfRev,
      depth: opts.depth,
    }),
    // Cached per backend revision (graph-health.ts); in parallel, so free
    // on a warm cache.
    checkGraphHealth(client, activeReadScope()),
  ]);
  const provenance = facts.provenance;

  const bundle = buildBundle({
    resolved,
    facts,
    context,
    provenance,
    asOfRev,
    depth: opts.depth,
    budgets,
    format: fmt,
    graphCompleted: hasCompletedSourceGraphBaseline(),
    graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
  });

  await emitBundle(bundle, opts);
}

/** `--save`, `--out`, or render: what every freshly built bundle goes through. */
async function emitBundle(bundle: ContextBundle, opts: ContextOptions): Promise<void> {
  if (opts.save || opts.out) reportGuessedTargetForArtifact(opts.format);
  if (opts.save) {
    saveInvestigation(opts.save, bundle);
    renderNote(`Saved investigation "${opts.save}" (${bundle.entities.length} entities, ${bundle.relationships.length} relationships, ${bundle.evidence.length} evidence items). Resume with: ix context --resume ${opts.save}`);
    return;
  }

  if (opts.out && opts.format !== "json") {
    // stderr: --out still writes the file and still prints a note, so this
    // advisory would otherwise sit in the stdout an `llm` caller is reading.
    renderWarningErr("--out writes JSON; ignoring --format and forcing json.");
  }
  const out = opts.out;
  if (out) {
    const fs = await import("node:fs");
    // Validate the network-derived bundle against the versioned contract
    // before persisting it: only a bundle matching ix-context-bundle/1 is
    // written, so a malformed or unexpected backend payload can never land
    // in a caller-owned file (CodeQL js/network-data-written-to-file).
    const parsed = contextBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      reportFailure(
        "out_refused",
        `--out "${out}" refused: the bundle does not match the ${BUNDLE_SCHEMA} schema (${parsed.error.issues.length} issue(s)).`,
        opts.format,
      );
      return;
    }
    // Atomic write: serialize to a private temp file in the SAME directory,
    // then rename over the target, so the write is never a check-then-write
    // race and a partial file is never visible (CodeQL js/file-system-race;
    // same pattern as the config writer in src/cli/config.ts). Renaming
    // onto an existing directory fails, which surfaces as the refusal below.
    const targetPath = resolve(out);
    const tmpPath = join(dirname(targetPath), `.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EISDIR" || err.code === "EPERM") {
        try {
          if (fs.statSync(targetPath).isDirectory()) {
            reportFailure(
              "out_refused",
              `--out "${out}" is a directory; refusing to write the bundle there.`,
              opts.format,
            );
            return;
          }
        } catch { /* target may not exist; fall through to rethrow */ }
      }
      throw error;
    }
    renderNote(`Wrote ${parsed.data.entities.length} entities, ${parsed.data.relationships.length} relationships, ${parsed.data.evidence.length} evidence items to ${out}`);
    return;
  }
  renderBundle(bundle, opts.format);
}

/**
 * Say which entity a guessed target became, when the bundle goes to a file.
 *
 * A json caller's `ambiguous_target` / `fuzzy_match` notice waits in the queue
 * for `printJson` (ui.ts `reportResolutionNotices`), and `--save` / `--out`
 * never call it: the bundle goes to a file whose versioned schema
 * (ix-context-bundle/1) has no field for it, and stdout gets a prose note. So
 * the notice goes to stderr here, as a warning `--quiet` does not hide: it is
 * the only sign that the saved bundle is for a guess. text and llm already
 * printed it when the target resolved.
 */
function reportGuessedTargetForArtifact(format: string | undefined): void {
  if (format !== "json") return;
  const notices = takeResolutionNotices() as ResolutionNotice[];
  for (const notice of notices) {
    renderWarningErr(notice.message);
    if (notice.code !== "ambiguous_target") continue;
    notice.candidates.forEach((candidate, index) => {
      const where = candidate.path ? ` in ${candidate.path}` : "";
      console.error(`  ${index + 1}. ${(candidate.kind ?? "").padEnd(10)} ${candidate.id.slice(0, 8)}  ${candidate.name}${where}`);
    });
    if (notice.total > notice.candidates.length || notice.truncated) {
      console.error(`  Showing ${notice.candidates.length} of ${notice.truncated ? ">=" : ""}${notice.total}`);
    }
    console.error("  Use --pick <n> or --path to choose another.");
  }
}
