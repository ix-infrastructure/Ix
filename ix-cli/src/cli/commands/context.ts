// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  BUNDLE_SCHEMA,
  contextBundleSchema,
  savedInvestigationSchema,
} from "../context-bundle-schema.js";

import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import type {
  ConflictReport,
  DecisionReport,
  GraphNode,
  IntentReport,
  StructuredContext,
} from "../../client/types.js";
import { resolveWorkspaceRoot } from "../config.js";
import { collectFacts, type ContextFacts, type EntityLocation } from "../explain/facts.js";
import {
  CENTRE_FALLBACK_TRIES,
  chooseCentre,
  CLOSENESS_BOOST,
  leanIssueView,
  planIssue,
  rankIssueFiles,
  readIssueText,
  type Closeness,
  type LeanIssueView,
  type RankedFile,
  type StartingPoint,
  type SymbolHit,
} from "../explain/issue.js";
import { collectRelatedFiles, MAX_RELATED, type RelatedRef } from "../explain/related-files.js";
import { cachedBm25Ranker } from "../explain/bm25-cache.js";
import { collectTextReferences, gitRepoAccess, type TextSource } from "../explain/text-references.js";
import { coChangedFiles, gitRunner, recentCommits, type CommitRef } from "../explain/history.js";
import { llmLine, llmShortId, printLlmLines } from "../llm.js";
import { parseBudgetOption, parsePickOption, parseRevisionOption } from "../options.js";
import { activeReadScope, ensureReadScope, resolveFileOrReport } from "../resolve.js";
import { createStaleProbe, hasCompletedSourceGraphBaseline } from "../stale.js";
import { renderNote, renderSection, renderWarning, renderWarningErr, reportFailure } from "../ui.js";
import { printJson, relativePath } from "../format.js";
import { forMcp, suggest, toolCall } from "../next-step.js";
import {
  assessTargetStructure, checkGraphHealth, graphHealthJson, isUnhealthy, worseHealth, type GraphHealth,
} from "../graph-health.js";

/** The `--max-*` knobs that bound a bundle. */
interface BudgetSnapshot {
  maxEntities: number;
  maxRelationships: number;
  maxEvidence: number;
  maxTokens: number;
  maxChars: number;
}

/**
 * The budgets, described once: flag key, output label, clamp range, and the
 * default applied when the flag is absent.
 *
 * These four facts used to live in five hand-maintained places -- the option
 * registration, the `clampInt` calls, the record fields, the prose formatter
 * and the requested-budget reader -- so a fifth budget meant five edits and
 * missing one was silent. They had already drifted: a comment on the
 * registration described `clampInt(opts.max*, 1, 500, 50)` as if it were the
 * rule for all four, which is right for entities and wrong for the rest
 * (`--max-chars` is 1000-1000000 defaulting to 12000). Everything below reads
 * this table, and `--help` interpolates it, so the number a user is told is
 * the number that is applied.
 */
/**
 * Hard cap on the conflict reports carried in a bundle. Not a `--max-*` flag:
 * the bundle reports the count it saw either way, and a caller who needs every
 * report wants `ix conflicts`, not a bigger context bundle.
 */
const MAX_CONFLICTS = 10;

const BUDGETS = [
  { key: "maxEntities", flag: "--max-entities", label: "entities", help: "Maximum entities in the bundle", min: 1, max: 500, fallback: 50 },
  { key: "maxRelationships", flag: "--max-relationships", label: "relationships", help: "Maximum relationships in the bundle", min: 1, max: 1000, fallback: 100 },
  { key: "maxEvidence", flag: "--max-evidence", label: "evidence", help: "Maximum evidence items in the bundle", min: 1, max: 200, fallback: 25 },
  { key: "maxTokens", flag: "--max-tokens", label: "tokens", help: "Maximum tokens of evidence output", min: 500, max: 200_000, fallback: 3_000 },
  { key: "maxChars", flag: "--max-chars", label: "chars", help: "Maximum characters of evidence output", min: 1000, max: 1_000_000, fallback: 12_000 },
] as const satisfies ReadonlyArray<{
  key: keyof BudgetSnapshot;
  flag: string;
  label: string;
  help: string;
  min: number;
  max: number;
  fallback: number;
}>;

/**
 * `--help` text for one budget flag.
 *
 * The Commander defaults were removed so an absent flag is distinguishable
 * from one set to the default value -- `--diff` reports which budgets the
 * caller actually asked for. Removing them also removed `(default: "50")` from
 * `ix context --help`, leaving four flags whose default and range a user could
 * not discover from the CLI at all, so the text says both, read off the table
 * that enforces them.
 */
function budgetHelp(key: keyof BudgetSnapshot): string {
  const b = budgetField(key);
  return `${b.help} (default: ${b.fallback}, clamped to ${b.min}-${b.max})`;
}

/** The table row for one budget. */
function budgetField(key: keyof BudgetSnapshot): (typeof BUDGETS)[number] {
  return BUDGETS.find((entry) => entry.key === key)!;
}

/**
 * The Commander `argParser` for one budget flag.
 *
 * The example in the rejection message comes from the flag's own default, not
 * from a constant: a single hardcoded "50" told someone who mistyped
 * `--max-chars` to try 50, which parses and is then silently clamped up to 1000
 * by `clampBudgets` -- while the help text one line away says the range is
 * 1000-1000000.
 */
function budgetParser(key: keyof BudgetSnapshot): (value: string) => number {
  const example = String(budgetField(key).fallback);
  return (value: string) => parseBudgetOption(value, example);
}

/**
 * Characters per token in a real bundle.
 *
 * Measured across 41 recorded bundles whose prompts differed only by the
 * bundle: 2.14, against the ~4 of ordinary English. A bundle is dense
 * `key=value` and JSON with identifiers in it, and identifiers tokenize badly.
 *
 * Conservative on purpose, and it stays conservative as the bundle gets
 * cleaner: pulling identifier-heavy rows out raises the real ratio, so an
 * estimate pinned at 2.14 over-counts tokens and the bundle comes in under its
 * budget rather than over it. Re-measure before lowering it, never raise it to
 * make a bundle fit.
 */
export const BUNDLE_CHARS_PER_TOKEN = 2.14;

/**
 * Apply the table's range and default to whatever the caller supplied, and
 * turn the token budget into the character budget that bounds the evidence.
 *
 * `--max-tokens` is the budget a caller actually has: the thing being spent is
 * a context window, and 12,000 characters is a number nobody can convert in
 * their head into what it costs them. `--max-chars` stays for the caller who
 * needs exact bytes, and wins outright when passed — the two together are
 * refused up front rather than silently ranked, because which one lost is not
 * visible in the output.
 */
export function clampBudgets(opts: Partial<BudgetSnapshot>): BudgetSnapshot {
  const out = {} as BudgetSnapshot;
  for (const b of BUDGETS) {
    const raw = opts[b.key];
    out[b.key] = raw === undefined ? b.fallback : Math.min(b.max, Math.max(b.min, raw));
  }
  if (opts.maxChars === undefined) {
    const chars = budgetField("maxChars");
    out.maxChars = Math.min(
      chars.max,
      Math.max(chars.min, Math.round(out.maxTokens * BUNDLE_CHARS_PER_TOKEN)),
    );
  }
  return out;
}

interface ContextOptions extends Partial<BudgetSnapshot> {
  /** An issue or bug report to start from, in place of a target: a file, or `-` for stdin. */
  fromIssue?: string;
  /** With `--from-issue`: only the trusted starting points and a few ranked files. */
  lean?: boolean;
  kind?: string;
  path?: string;
  pick?: number;
  depth?: string;
  asOfRev?: number;
  out?: string;
  save?: string;
  resume?: string;
  diff?: string;
  list?: boolean;
  format: string;
}

const CONTEXT_DEPTHS = ["compact", "standard", "full", "shallow", "deep"] as const;

/**
 * The depth vocabulary the backend understands, and what to do about anything
 * else.
 *
 * `ContextService` normalizes `shallow`->`compact` and `deep`->`full`, then
 * picks its limits with a `case _` that lands every unrecognized value on the
 * `standard` tier. So `--depth 2` was never an error: it silently ran a
 * standard-depth query, and scripts have been passing values like it.
 *
 * Rejecting those outright would be a breaking change in a patch release, for
 * a flag whose wrong values were previously harmless. So this warns and does
 * exactly what the backend already did with them — the typo still gets
 * surfaced, on stderr so `--format json` and `--format llm` stay parseable,
 * but nobody's pipeline starts exiting 1 on upgrade.
 *
 * Deliberately not an `InvalidArgumentError`, unlike `--pick` and `--as-of-rev`
 * next to it: those reject values that have no defined meaning, whereas this
 * one has a defined meaning and it is `standard`.
 */
export function parseContextDepthOption(value: string): string {
  const normalized = value.trim().toLowerCase();
  if ((CONTEXT_DEPTHS as readonly string[]).includes(normalized)) return normalized;

  renderWarningErr(
    `--depth ${value} is not one of ${CONTEXT_DEPTHS.join(", ")}; using standard.`
  );
  return "standard";
}

/** Stable evidence kinds, ordered by relevance tier (lower is more relevant). */
type EvidenceKind =
  | "target"
  | "structural"
  | "claim"
  | "decision"
  | "conflict"
  | "intent"
  | "relationship"
  | "provenance";

/** Where an evidence item is defined, when the graph knows. */
interface EvidenceLocation {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  title: string;
  /** Deterministic relevance score: tier plus a stable tiebreaker. */
  score: number;
  reason: string;
  refs: string[];
  /**
   * Without it an agent handed `member resolveWorkspaceRoot` has to search the
   * repository for the thing Ix just found -- and for a file target named
   * `config.ts`, first work out which of several `config.ts` files it was.
   */
  location?: EvidenceLocation;
}

interface ContextBundle {
  schema: typeof BUNDLE_SCHEMA;
  /** The one explicitly declared time-dependent field. */
  generatedAt: string;
  target: { id: string; name: string; kind: string; resolutionMode: string; path?: string };
  /**
   * Where an issue's bundle starts, and what in the issue did not resolve.
   * Only on a bundle built with `--from-issue`; absent, not empty, otherwise.
   */
  issue?: IssueSummary;
  /** The files to read for the issue, best first. Only with `--from-issue`. */
  rankedFiles?: RankedFile[];
  entities: Array<{
    id: string;
    name: string;
    kind: string;
    path?: string;
    lineStart?: number;
    lineEnd?: number;
    stale: boolean;
  }>;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  claims: Array<{ id: string; entityId: string; statement: string; status: string }>;
  decisions: DecisionReport[];
  conflicts: ConflictReport[];
  intents: IntentReport[];
  provenance: {
    sourceUri?: string;
    sourceHash?: string;
    extractor?: string;
    sourceType?: string;
    observedAt?: string;
    introducedRev?: number;
    historyLength: number;
    stale: boolean;
  };
  /**
   * `degraded` when the graph has lost its structural edges (see
   * graph-health.ts): nothing is known to have changed on disk, but the
   * bundle's members, callers and neighbours are missing, not absent.
   */
  freshness: { stale: boolean; classification: "current" | "stale" | "unverified" | "degraded" };
  /** Present only for a degraded or empty graph: what is wrong and the fix. */
  graph?: Record<string, unknown>;
  evidence: EvidenceItem[];
  budgets: BudgetSnapshot;
  truncation: {
    entitiesTruncated: number;
    relationshipsTruncated: number;
    evidenceTruncated: number;
    charactersTruncated: number;
    conflictsTruncated: number;
    /**
     * What the budget dropped, by category, largest first.
     *
     * The counts above say how much went; this says what it was. "Rerun with
     * larger --max-* budgets" was the same sentence for a file that lost 36 of
     * its own members and for a symbol that lost two claims, and it named the
     * one lever that costs the caller the most to pull.
     */
    cut?: Array<{ what: string; count: number }>;
  };
  metadata: {
    asOfRev?: number;
    depth?: string;
    rankingRule: "deterministic-tier";
  };
}

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
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
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
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--out <path>", "Write the JSON bundle to this file instead of stdout")
    .option("--save <id>", "Persist the bundle as a resumable investigation state")
    .option("--resume <id>", "Render a saved investigation state without a backend")
    .option("--diff <id>", "Diff a saved investigation against a fresh build of the same target")
    .option("--list", "List saved investigations (no target, no backend)")
    .addHelpText(
      "after",
      "\nExamples:\n  ix context IngestionService\n  ix context src/main.ts --format json\n  ix context --from-issue issue.md --format llm\n  gh issue view 123 --json body -q .body | ix context --from-issue -\n  ix context Widget --max-entities 20 --max-evidence 10\n  ix context Widget --save widget-investigation\n  ix context --resume widget-investigation\n  ix context --diff widget-investigation\n  ix context --list",
    )
    .action(async (target: string | undefined, opts: ContextOptions) => {
      const conflict = detectContextModeConflict(opts, target);
      if (conflict) {
        reportFailure("mode_conflict", conflict, opts.format);
        return;
      }
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
        const saved = loadInvestigation(opts.diff, opts.format);
        if (!saved) return;
        if (saved.bundle.issue && !target) {
          // The fresh side would be `ix context <centre>`: a named-target
          // bundle without the issue's rows, so every diff would report them
          // removed. The issue's text is not saved, so it cannot be rebuilt.
          reportFailure(
            "diff_unsupported",
            `Investigation "${opts.diff}" was built with --from-issue, and --diff can only rebuild a bundle from a named target. Run ix context --resume ${opts.diff} to see it, or build it again with --from-issue.`,
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
        const fresh = await buildFreshBundle(
          target ?? saved.bundle.target.name,
          { ...opts, ...mergeDiffOptions(saved, opts) },
          saved.bundle.budgets,
          opts.format,
        );
        if (!fresh) return;
        renderInvestigationDiff(saved, fresh, opts.format, requestedBudgets);
        return;
      }
      if (opts.fromIssue && opts.lean) {
        await emitLeanIssue(opts.fromIssue, opts);
        return;
      }
      if (opts.fromIssue) {
        const bundle = await buildIssueBundle(opts.fromIssue, opts, clampBudgets(opts));
        if (bundle) await emitBundle(bundle, opts);
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

      const client = createClient({ query: true });

      const resolved = await resolveFileOrReport(client, target, {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick,
      }, opts.format);
      if (!resolved) return;

      const budgets = clampBudgets(opts);
      const asOfRev = opts.asOfRev;

      const [facts, context, workspaceHealth] = await Promise.all([
        // Also carries the provenance response: `collectFacts` needs it for the
        // history length, and fetching it again here doubled one of the
        // slowest calls the command makes (~1.3s on the Ix repo's graph).
        collectContextFacts(client, resolved),
        // By id, not by name. Seeding by name makes the backend re-run the
        // search the resolver just did, and it can land on a different node of
        // the same name. Both call sites in this file must use it: converting
        // only one makes `--diff` compare a by-id bundle against a by-name one
        // and report the whole graph as changed.
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
        graphCompleted: hasCompletedSourceGraphBaseline(),
        graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
      });

      await emitBundle(bundle, opts);
    });

/** `--save`, `--out`, or render: what every freshly built bundle goes through. */
async function emitBundle(bundle: ContextBundle, opts: ContextOptions): Promise<void> {
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

async function buildFreshBundle(
  target: string,
  opts: { kind?: string; path?: string; pick?: number; depth?: string; asOfRev?: number },
  budgets: BudgetSnapshot,
  format: string,
): Promise<ContextBundle | undefined> {
  const client = createClient({ query: true });
  const resolved = await resolveFileOrReport(client, target, {
    kind: opts.kind,
    path: opts.path,
    pick: opts.pick,
  }, format);
  if (!resolved) return undefined;

  const asOfRev = opts.asOfRev;
  const [facts, context, workspaceHealth] = await Promise.all([
    collectContextFacts(client, resolved),
    client.contextForNode(resolved.id, { asOfRev, depth: opts.depth }),
    checkGraphHealth(client, activeReadScope()),
  ]);

  return buildBundle({
    resolved, facts, context, provenance: facts.provenance, asOfRev, depth: opts.depth, budgets,
    graphCompleted: hasCompletedSourceGraphBaseline(),
    graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
  });
}
}


/**
 * What `detectContextModeConflict` reads: all of `ContextOptions`.
 *
 * Derived from the action handler's own declaration, never hand-copied. The
 * detector exists to stop a typed flag being a no-op, so a shape it maintains
 * separately is the one thing it cannot afford: written out field-by-field it
 * drifted immediately, when `--list` was added to `ContextOptions` on a sibling
 * branch and the detector could not see it with nothing from the typechecker to
 * say so. `Partial` so the pure function can be called with one flag at a time
 * in a test, without inventing a `format`.
 */
export type ContextModeOptions = Partial<ContextOptions>;

/**
 * Flags that shape a bundle this run builds, and are therefore meaningless to a
 * mode that builds none.
 *
 * `--list` enumerates saved state and `--resume` renders it verbatim; neither
 * resolves a target or applies a budget, so every one of these was accepted and
 * dropped in silence — `ix context --list --max-entities 10 --kind class` took
 * five typed flags and exited 0. `--diff` is not here: it re-resolves the target
 * with `--kind`/`--path`/`--pick`, forwards `--depth`/`--as-of-rev` through
 * `mergeDiffOptions`, and reports the `--max-*` values rather than dropping
 * them.
 *
 * Listed as `[field, flag]` because the message has to name what the user
 * typed, and Commander's camelCase attribute is not that.
 */
const BUILD_FLAGS: ReadonlyArray<[keyof ContextOptions, string]> = [
  ["fromIssue", "--from-issue"],
  ["kind", "--kind"],
  ["path", "--path"],
  ["pick", "--pick"],
  ["depth", "--depth"],
  ["asOfRev", "--as-of-rev"],
  ...BUDGETS.map((b) => [b.key, b.flag] as [keyof ContextOptions, string]),
];

/**
 * Detect mutually-incompatible mode/output flags on `ix context` and return a
 * human-readable message naming the conflict, or `undefined` if no conflict.
 *
 * The action handler used to silently drop `--save` and `--out` whenever
 * `--resume` or `--diff` was passed (those branches `return` before the
 * `--save`/`--out` branches ever run). It also accepted `--save <id>` alongside
 * `--out <file>`, which describes two different write targets and so has no
 * well-defined combined behaviour. Catching these combinations up front and
 * surfacing them as a hard error mirrors the explicit-conflict style in
 * subsystems.ts and prevents the user's typed flag from being a no-op.
 *
 * `--list` is checked here rather than inside the list branch, and that is the
 * point rather than tidiness. Its own guard sat below `if (opts.resume)`, which
 * returns first, so the `--list --resume` arm of it could never fire: the user
 * asked for a listing, silently got one investigation rendered, and the exit
 * code said it went fine. A guard that runs before every mode branch cannot
 * lose that race.
 *
 * `target` is a parameter because a positional is as ignorable as a flag:
 * `ix context Widget --list` and `ix context Widget --resume x` both dropped it
 * with nothing said.
 */
export function detectContextModeConflict(
  opts: ContextModeOptions,
  target?: string,
): string | undefined {
  if (opts.lean && opts.fromIssue === undefined) {
    return "--lean only shapes a bundle built with --from-issue; add --from-issue <file>, or drop --lean.";
  }
  if (opts.lean && (opts.save || opts.out)) {
    return `--lean cannot be combined with ${opts.save ? "--save" : "--out"}; a lean view is a few lines of pointers, not a bundle to persist. Drop --lean to save the full bundle.`;
  }
  if (opts.list && target) {
    return `--list takes no target; it enumerates every saved investigation. Drop "${target}", or drop --list to build a fresh bundle for it.`;
  }
  if (opts.resume && target) {
    return `--resume takes no target; it renders the investigation you name, whatever that was built for. Drop "${target}", or use --diff <id> to compare a saved investigation against a fresh build of it.`;
  }
  if (opts.fromIssue !== undefined) {
    // The issue is the target: it names its own starting points, so a second
    // target, or a flag that narrows the candidates for one, has nothing to
    // act on. `--diff` rebuilds a saved investigation by its target's name,
    // which a bundle built from an issue does not have.
    if (target) {
      return `--from-issue takes no target; the issue's text picks the starting points. Drop "${target}", or drop --from-issue to build a bundle for it.`;
    }
    if (opts.diff) {
      return "--from-issue cannot be combined with --diff; --diff rebuilds a saved investigation from its target's name. Save the issue's bundle with --save and --resume it instead.";
    }
    const narrowing = ([["kind", "--kind"], ["path", "--path"], ["pick", "--pick"]] as const)
      .filter(([field]) => opts[field] !== undefined)
      .map(([, flag]) => flag);
    if (narrowing.length > 0 && !opts.list && !opts.resume) {
      return `${narrowing.join(", ")} cannot be combined with --from-issue; ${narrowing.length > 1 ? "they narrow" : "it narrows"} the candidates for a named target, and the issue's starting points are chosen from its text.`;
    }
  }
  // Flags that shape a bundle, given to a mode that builds none. Reported as
  // one message naming every offender, because dropping one at a time and
  // re-running to find the next is the experience this detector exists to
  // avoid, and the flags are all wrong for the same reason.
  for (const [mode, why] of [
    ["list", "--list enumerates saved investigations and builds no bundle"],
    ["resume", "--resume renders a saved investigation exactly as it was built"],
  ] as const) {
    if (!opts[mode]) continue;
    const ignored = BUILD_FLAGS.filter(([field]) => opts[field] !== undefined).map(([, flag]) => flag);
    if (ignored.length > 0) {
      return `${ignored.join(", ")} cannot be combined with --${mode}; ${why}, so ${ignored.length > 1 ? "those flags change" : "that flag changes"} nothing. Drop ${ignored.length > 1 ? "them" : "it"}, or run ix context <target> to build a bundle with ${ignored.length > 1 ? "them" : "it"}.`;
    }
  }
  if (opts.maxTokens !== undefined && opts.maxChars !== undefined) {
    // Refused rather than ranked. They bound the same thing — the evidence
    // block — in two units, and whichever one lost does not appear anywhere in
    // the output, so a caller who set both would have no way to tell which
    // budget was applied. Same rule `ix diff` uses for --summary and --limit.
    return "--max-tokens and --max-chars cannot be combined; both bound the evidence block, in different units. Use --max-tokens for a context-window budget, or --max-chars for exact bytes.";
  }
  if (opts.list && opts.resume) {
    return "--list and --resume cannot be combined; --list enumerates saved investigations, --resume renders one. Run --list first, then --resume the id you want.";
  }
  if (opts.list && opts.diff) {
    return "--list and --diff cannot be combined; --list enumerates saved investigations, --diff compares one against a fresh build.";
  }
  if (opts.list && opts.save) {
    return "--list cannot be combined with --save; --list reads saved investigations, --save writes one, and --list builds no bundle to write.";
  }
  if (opts.list && opts.out) {
    return "--list cannot be combined with --out; --list enumerates to stdout."
      + " Redirect it (`ix context --list --format json > <path>`) if you need the listing on disk.";
  }
  if (opts.resume && opts.diff) {
    return "--resume and --diff cannot be combined; --resume renders a saved investigation, --diff renders a comparison against one.";
  }
  if (opts.resume && opts.save) {
    return "--resume cannot be combined with --save; --resume only renders a saved investigation, while --save writes a new one. Run --save on a fresh build instead.";
  }
  if (opts.resume && opts.out) {
    // No "use --format json with --out" hint here. That hint was unactionable:
    // this branch fires on `--resume` plus `--out` whatever the format, so a
    // user who followed it landed straight back on the same error, this time
    // with no advice at all. The two things that do work are a redirect and
    // the saved file itself, so name those.
    return "--resume cannot be combined with --out; --resume renders to stdout."
      + " Redirect it (`ix context --resume <id> --format json > <path>`), or read"
      + " IX_HOME/investigations/<id>.json, which is already the saved JSON.";
  }
  if (opts.diff && opts.save) {
    return "--diff cannot be combined with --save; --diff renders a comparison against a saved investigation. To persist the fresh side as a new investigation, run the fresh build without --diff and use --save there.";
  }
  if (opts.diff && opts.out) {
    return "--diff cannot be combined with --out; --diff renders the comparison to stdout.";
  }
  if (opts.save && opts.out) {
    return "--save and --out cannot be combined; --save writes to IX_HOME/investigations/<id>.json, while --out writes to a caller-chosen path. Pick one.";
  }
  return undefined;
}

/** Saved investigation state lives under ~/.ix/investigations. */
function investigationDir(): string {
  // IX_HOME is the Ix home *directory*, not the investigations directory —
  // backend-status.ts, docker.ts and upgrade.ts all read it as `IX_HOME ||
  // ~/.ix` and then join their own subdirectory onto it. Putting the subdirectory
  // only in the fallback made the two branches disagree: with IX_HOME set, saved
  // investigations landed loose in the Ix home beside config.yaml, bin/ and cli/,
  // and `investigations/` was never created at all.
  return join(process.env.IX_HOME || join(homedir(), ".ix"), "investigations");
}

function investigationPath(id: string): string {
  return join(investigationDir(), `${sanitizeId(id)}.json`);
}

/**
 * Encode an investigation id into a filesystem-safe file name, injectively.
 *
 * `[A-Za-z0-9._-]` passes through unchanged; every other UTF-16 code unit —
 * including the escape marker `~` itself — is hex-encoded, as `~HH` below
 * U+0100 and `~uHHHH` at or above it. Two different logical ids can therefore
 * never map to the same file, and a raw `~` in user input cannot be confused
 * with an encoding: `a/b`, `a?b`, and `a~2Fb` all land in distinct,
 * single-segment files under the investigation directory instead of silently
 * colliding or escaping it.
 *
 * A leading `.` is encoded too, so no id can produce a dotfile. `.` is otherwise
 * an ordinary character here, and encoding it only in first position keeps the
 * mapping injective: `.a` becomes `~2Ea`, which no other id can also produce.
 */
export function sanitizeId(id: string): string {
  let out = "";
  // Iterate UTF-16 code units, not code points. `for...of` walks code points
  // while `charCodeAt(0)` reads only the leading surrogate, so every astral
  // character encoded as just its high surrogate and they all collided (#478).
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
      continue;
    }
    const code = id.charCodeAt(i);
    // Two escape widths, and the `u` is what keeps them apart. A bare
    // `~HHHH` would be ambiguous: `~D83D` reads equally well as one code unit
    // or as `~D8` followed by the literal characters `3D`, and hex digits pass
    // through unencoded, so both readings are producible. That is not
    // hypothetical — it is how U+1F600 collided with the ordinary string
    // `Ø3DÞ00`, which is the same overwrite bug #478 was about, one layer down.
    //
    // `u` cannot be confused with the narrow form because it is not a hex
    // digit, and a literal `~` in the input is itself encoded (`~7E`), so the
    // character after an escape marker is never user data.
    //
    // The narrow form is kept for everything below U+0100 so that every id
    // already on disk keeps the name it was saved under.
    out += code < 0x100
      ? `~${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `~u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  if (out.startsWith(".")) out = `~2E${out.slice(1)}`;
  return out || "unnamed";
}

/**
 * The id to show the user, given the id stored on disk.
 *
 * `sanitizeId` is deliberately *not* idempotent — it encodes `~` as `~7E` so a
 * raw `~` cannot be mistaken for an escape — so the stored form is the wrong
 * thing to hand back. `ix context --list` printed it next to "Resume with:
 * ix context --resume <id>", and `--resume` sanitizes what it is given: an id
 * saved as `widget/auth` was listed as `widget~2Fauth`, and resuming that
 * looked for `widget~7E2Fauth`, which does not exist.
 *
 * Decodes both escape widths and then re-encodes to check itself, rather than
 * trusting the decode. The check is not ceremony: ids written before the
 * `~uHHHH` form existed still carry bare `~HHHH`, which decodes to a different
 * string than it was saved from, and the re-encode is what catches that and
 * returns the stored id untouched instead of showing a plausible wrong answer.
 * `loadInvestigation` accepts the stored form too, so a listed id loads either
 * way — the display is the nicety, the load is the contract.
 */
export function displayId(stored: string): string {
  const decoded = stored.replace(
    /~u([0-9A-Fa-f]{4})|~([0-9A-Fa-f]{2})/g,
    (_m, wide: string | undefined, narrow: string | undefined) =>
      String.fromCharCode(parseInt(wide ?? narrow ?? "", 16)),
  );
  return sanitizeId(decoded) === stored ? decoded : stored;
}

/**
 * The shape `sanitizeId` produces: what a file in the investigations directory
 * can be named, and therefore what `loadInvestigation` may accept verbatim.
 *
 * The leading character excludes `.` so no input names a dotfile, and the set
 * excludes every path separator, so nothing here can address a second directory
 * segment or a parent.
 */
const STORED_ID = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

export function saveInvestigation(id: string, bundle: ContextBundle): void {
  const dir = investigationDir();
  mkdirSync(dir, { recursive: true });
  // Refuse to persist a bundle that does not match the versioned contract:
  // network-derived investigation state is validated before it reaches disk
  // (CodeQL js/network-data-written-to-file).
  const parsed = contextBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    renderWarning(`Refusing to save investigation "${id}": the bundle does not match the ${BUNDLE_SCHEMA} schema (${parsed.error.issues.length} issue(s)).`);
    return;
  }
  const state = {
    schema: "ix-investigation/1",
    id: sanitizeId(id),
    savedAt: new Date().toISOString(),
    bundle: parsed.data,
  };
  // Atomic write (temp + rename in the same directory), matching the config
  // writer, so a saved investigation is never partially written (CodeQL
  // js/file-system-race).
  const path = investigationPath(id);
  const tmpPath = join(dirname(path), `.${process.pid}.${Date.now().toString(36)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

interface SavedInvestigation {
  schema: string;
  id: string;
  savedAt: string;
  bundle: ContextBundle;
}

/**
 * Carry the saved investigation's revision and depth into a fresh `--diff`
 * build unless the caller explicitly overrides them, so a plain
 * `ix context --diff <id>` compares like-for-like instead of silently
 * re-basing the saved state onto current HEAD.
 */
export function mergeDiffOptions(
  saved: SavedInvestigation,
  opts: { asOfRev?: number; depth?: string },
): { asOfRev?: number; depth?: string } {
  // Numbers on both sides now: `--as-of-rev` is validated by its Commander
  // argParser, so the round trip through a string that this used to do -- and
  // the `parseInt` on the far side of it -- is gone.
  return {
    asOfRev: opts.asOfRev ?? saved.bundle.metadata.asOfRev,
    depth: opts.depth ?? saved.bundle.metadata.depth,
  };
}

/**
 * Enumerate every saved investigation under IX_HOME/investigations.
 *
 * Validated with `savedInvestigationSchema` — the same contract the write side
 * and `loadInvestigation` enforce — rather than a hand-rolled envelope check
 * beside it. A file that fails it is skipped and counted; the count is
 * returned, not printed, because this runs before the renderer knows which
 * format was asked for.
 *
 * Determinism: newest first by `savedAt`, falling back to the id so two files
 * saved in the same millisecond still order stably across runs.
 */
export function listInvestigations(): { saved: SavedInvestigation[]; skipped: number } {
  const dir = investigationDir();
  if (!existsSync(dir)) return { saved: [], skipped: 0 };
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: SavedInvestigation[] = [];
  let skipped = 0;
  for (const file of entries) {
    let raw: unknown;
    // Scoped to the read and the parse, as in `loadInvestigation`: they are the
    // only calls here that throw.
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      skipped += 1;
      continue;
    }
    const parsed = savedInvestigationSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    // The validated value, not the raw parse — the same assertion
    // `loadInvestigation` makes, and for the same reason: it re-narrows the
    // open report arrays the schema leaves as records, and every field the
    // renderer dereferences has been checked by this point. The id is decoded
    // here too, so every reader of an enumerated investigation sees the id it
    // can type back — see `displayId`.
    const state = parsed.data as unknown as SavedInvestigation;
    out.push({ ...state, id: displayId(state.id) });
  }
  out.sort((a, b) => {
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
    return cmp(a.id, b.id);
  });
  return { saved: out, skipped };
}

/** One saved investigation as `--list` describes it: what it is, not what is in it. */
interface InvestigationSummary {
  /** The id to type back, not the id on disk — decoded by `displayId` on read. */
  id: string;
  savedAt: string;
  target: { name: string; kind: string };
  freshness: ContextBundle["freshness"];
  counts: { entities: number; relationships: number; evidence: number };
  truncation: ContextBundle["truncation"];
}

/** Summarise one saved investigation for the listing. */
function summariseInvestigation(s: SavedInvestigation): InvestigationSummary {
  const b = s.bundle;
  return {
    id: s.id,
    savedAt: s.savedAt,
    target: { name: b.target.name, kind: b.target.kind },
    freshness: b.freshness,
    counts: {
      entities: b.entities.length,
      relationships: b.relationships.length,
      evidence: b.evidence.length,
    },
    truncation: b.truncation,
  };
}

/**
 * Render the saved investigations produced by `listInvestigations`.
 *
 * Every format carries the same summary: what each investigation is, how big
 * it is, and how stale. Not the bundles themselves — `--list` is the discovery
 * step, and twenty saved investigations is twenty complete bundles, up to 50
 * entities, 100 relationships and 12000 characters of evidence each. A caller
 * that wants one of them asks for it by id with `--resume <id> --format json`.
 *
 * `skipped` is reported in each format's own terms, and never on stdout except
 * as a field — including in `json`, which returns an object for exactly that
 * reason: an array has nowhere to put it, so a machine caller could not tell
 * that files had been rejected while the human saw a warning saying so. It used
 * to be a `renderWarning` inside the enumerator — which is `console.log` — so a
 * single corrupt file prepended a chalk-coloured prose line to the payload and
 * `ix context --list --format json | jq` failed on it. The human warning goes to
 * stderr; the machine formats carry a count.
 */
export function renderInvestigationList(
  items: SavedInvestigation[],
  skipped: number,
  format: string,
): void {
  const summaries = items.map(summariseInvestigation);
  if (skipped > 0 && format !== "llm") {
    // `console.error`, not `renderWarning`: every renderer in ui.ts writes to
    // stdout, which is exactly how this line used to end up inside the JSON a
    // caller was piping. Plain text rather than chalk — nothing else in this
    // file writes to stderr, and a colour code is not worth an import that
    // only this line needs.
    renderWarningErr(
      `${skipped} saved investigation file(s) in ${investigationDir()} did not match the contract; skipped.`,
    );
  }
  if (format === "json") {
    printJson({ investigations: summaries, skipped });
    return;
  }
  if (format === "llm") {
    printLlmLines([
      // `skipped` is a field rather than a warning: it is the one thing about
      // the listing an agent cannot see from the records themselves.
      llmLine("investigations", { total: summaries.length, skipped: skipped || undefined }),
      ...summaries.map((s) =>
        llmLine("investigation", {
          id: s.id,
          saved_at: s.savedAt,
          target: s.target.name,
          target_kind: s.target.kind,
          classification: s.freshness.classification,
          stale: s.freshness.stale,
          entities: s.counts.entities,
          relationships: s.counts.relationships,
          evidence: s.counts.evidence,
          truncated_entities: s.truncation.entitiesTruncated,
          truncated_relationships: s.truncation.relationshipsTruncated,
          truncated_evidence: s.truncation.evidenceTruncated,
          truncated_chars: s.truncation.charactersTruncated,
        }),
      ),
    ]);
    return;
  }

  if (summaries.length === 0) {
    renderNote("No saved investigations. Use `ix context <target> --save <id>` to create one.");
    return;
  }
  renderSection(`Saved investigations (${summaries.length})`);
  for (const s of summaries) {
    console.log(`  ${s.id}`);
    console.log(`    target:       ${s.target.name} (${s.target.kind})`);
    console.log(`    saved_at:     ${s.savedAt}`);
    console.log(`    freshness:    ${s.freshness.classification}`);
    console.log(
      `    counts:       entities=${s.counts.entities} relationships=${s.counts.relationships} evidence=${s.counts.evidence}`,
    );
    if (
      s.truncation.entitiesTruncated ||
      s.truncation.relationshipsTruncated ||
      s.truncation.evidenceTruncated ||
      s.truncation.charactersTruncated
    ) {
      console.log(
        `    truncated:    entities=${s.truncation.entitiesTruncated} relationships=${s.truncation.relationshipsTruncated} evidence=${s.truncation.evidenceTruncated} chars=${s.truncation.charactersTruncated}`,
      );
    }
  }
  console.log();
  console.log(`Resume with: ix context --resume <id>`);
  console.log(`Diff with:   ix context --diff <id>`);
}

/**
 * Refuse a saved investigation: warn, and set a non-zero status so a scripted
 * `--resume`/`--diff` can tell a refusal from a successful render. The sibling
 * commands (config, init, map) already signal refusals this way.
 */
function refuseInvestigation(code: string, message: string, format?: string): undefined {
  // `--format llm` gets the record every sibling command emits for a failure
  // (`callers.ts`, `contains.ts`, `depends.ts`, `diff.ts`, `history.ts` all do
  // this, and docs/llm-format.md specifies the shape). This path used to write
  // `renderWarning`, which is `console.log`, so the one command being made
  // llm-clean answered a refusal with a chalk-coloured prose line in the middle
  // of the record stream — and with a prose line inside the JSON payload for a
  // `--format json` caller piping to `jq`. The human keeps the same wording, on
  // stderr, where prose belongs whatever the format.
  reportFailure(code, message, format);
  return undefined;
}

export function loadInvestigation(id: string, format?: string): SavedInvestigation | undefined {
  let path = investigationPath(id);
  if (!existsSync(path) && STORED_ID.test(id)) {
    // Also accept the on-disk form. `sanitizeId` is not idempotent, so an id
    // that is already encoded gets encoded again and misses its own file:
    // `widget/auth` is stored as `widget~2Fauth`, and asking for
    // `widget~2Fauth` looked for `widget~7E2Fauth`. `displayId` recovers the
    // typed form for every Latin-1 id, but the escape width is ambiguous above
    // that, so for the rest the encoded name is the only thing a listing can
    // print — and it has to work. Second, not first, so an id that is genuinely
    // spelled `widget~2Fauth` still finds its own file before this.
    const encoded = join(investigationDir(), `${id}.json`);
    if (existsSync(encoded)) path = encoded;
  }
  if (!existsSync(path)) {
    return refuseInvestigation("no_saved_investigation", `No saved investigation "${id}" at ${path}`, format);
  }
  let raw: unknown;
  // Scoped to the read and the parse: those are the only calls here that throw,
  // and widening it would report a validation or rendering failure below as
  // "not valid JSON" — naming the wrong cause on a file that parses fine.
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuseInvestigation("invalid_saved_investigation", `Saved investigation "${id}" is not valid JSON; refusing to resume.`, format);
  }

  // Validate the whole envelope coming back off disk against the same versioned
  // contract the write side enforces (saveInvestigation and --out). The two
  // halves were asymmetric: writes were schema-checked, reads trusted a bare
  // `as` cast guarded only by a truthiness check on `bundle`. That gap is
  // reachable — `--diff` re-resolves `bundle.target.name`, `metadata.depth` and
  // `metadata.asOfRev` and sends them to the backend, and `--resume` renders the
  // bundle — so a file whose `schema` field was right and whose body was
  // anything at all used to be honoured.
  const parsed = savedInvestigationSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // Distinguish the two version-skew cases from a generic shape mismatch, so
    // the warning names which contract was not met.
    if (issues.some((issue) => issue.path[0] === "schema")) {
      return refuseInvestigation("invalid_saved_investigation", `Saved investigation "${id}" has an unknown schema; refusing to resume.`, format);
    }
    if (issues.some((issue) => issue.path[0] === "bundle" && issue.path[1] === "schema")) {
      return refuseInvestigation(
        "invalid_saved_investigation",
        `Saved investigation "${id}" holds a bundle from a different contract than ${BUNDLE_SCHEMA}; refusing to resume.`,
        format,
      );
    }
    return refuseInvestigation(
      "invalid_saved_investigation",
      `Saved investigation "${id}" does not match the ${BUNDLE_SCHEMA} schema (${issues.length} issue(s)); refusing to resume.`,
      format,
    );
  }
  // Return the validated value, not the raw parse: saveInvestigation persists
  // `parsed.data` for the same reason, so unknown keys smuggled into a
  // hand-edited file are dropped here rather than echoed back out by
  // `--resume --format json` or copied into the emitted diff.
  //
  // The assertion re-narrows the three report arrays the schema deliberately
  // leaves as open records (decisions/conflicts/intents, whose shapes belong to
  // the backend) plus the literals zod widens to `string`. Every field this file
  // dereferences has been checked by this point — unlike the `as` cast on raw
  // JSON.parse output that this replaces, which checked nothing.
  //
  // The id is decoded here, at the one boundary every reader comes through,
  // rather than at each place one is printed. Decoding per call site is how
  // `--format llm` came to report `widget/auth` while `--format json` and the
  // text header reported `widget~2Fauth` for the same investigation, and a
  // JSON-chaining caller fed the second back to `--resume` and was refused.
  const state = parsed.data as unknown as SavedInvestigation;
  return { ...state, id: displayId(state.id) };
}

export function renderSavedInvestigation(id: string, format: string): void {
  const saved = loadInvestigation(id, format);
  if (!saved) return;
  if (format === "json") {
    printJson(saved);
    return;
  }
  if (format === "llm") {
    // A record, not the prose note below. `renderNote` would put a
    // chalk-coloured English sentence at the head of a record stream, and
    // it carries the one fact the bundle records do not: when this snapshot
    // was taken. `classification=current` says it was fresh when it was
    // saved, not when that was.
    printLlmLines([llmLine("resumed", { id: saved.id, saved_at: saved.savedAt })]);
    renderBundle(saved.bundle, format);
    return;
  }
  renderNote(`Resumed investigation "${saved.id}" saved ${saved.savedAt}`);
  renderBundle(saved.bundle, format);
}

/**
 * A budget snapshot as llm record fields.
 *
 * Absent values are simply absent — `llmField` drops nullish, so a partial
 * override needs no `not-given` sentinel the way the prose form does.
 */
function budgetFields(b: Partial<BudgetSnapshot>): Record<string, number | undefined> {
  return Object.fromEntries(BUDGETS.map((f) => [f.label, b[f.key]]));
}

/** Compact one-line representation of a budget snapshot for human rendering. */
function formatBudgets(b: Partial<BudgetSnapshot>, partial = false): string {
  const segments = BUDGETS.map((f) => {
    const val = b[f.key];
    return `${f.label}=${val === undefined ? "not-given" : String(val)}`;
  }).join(" ");
  return partial ? `${segments} (CLI override; not applied to --diff fresh side)` : segments;
}

/**
 * Which `--max-*` flags the caller actually passed, or `undefined` for none.
 *
 * Validation happens once, at parse time: `parseBudgetOption` is the flags'
 * Commander `argParser`, so a value that reaches here is already a positive
 * integer. Reading the raw strings back out with `Number.parseInt` was not a
 * check — it took `"10abc"` as 10, `"1e3"` as 1 and `"-5"` as -5, and this
 * record's whole purpose is reporting what the caller asked for, so a silently
 * repaired number is the one error it cannot afford.
 *
 * Deliberately *not* clamped, unlike `clampBudgets` on a direct run: these
 * values are reported, never applied — saved budgets govern `--diff` — so
 * clamping them would report a budget the caller did not ask for either. If
 * they are ever made to win on the fresh side, they must be clamped there.
 */
export function parseRequestedBudgets(opts: Partial<BudgetSnapshot>): Partial<BudgetSnapshot> | undefined {
  const out: Partial<BudgetSnapshot> = {};
  let provided = false;
  for (const f of BUDGETS) {
    const value = opts[f.key];
    if (value === undefined) continue;
    out[f.key] = value;
    provided = true;
  }
  return provided ? out : undefined;
}

export function diffInvestigations(
  saved: SavedInvestigation,
  fresh: ContextBundle,
  requestedBudgets?: Partial<BudgetSnapshot>,
): InvestigationDiff {
  const prev = saved.bundle;
  const addedEntities = fresh.entities.filter((e) => !prev.entities.some((p) => p.id === e.id));
  const removedEntities = prev.entities.filter((p) => !fresh.entities.some((e) => e.id === p.id));
  const addedRelationships = fresh.relationships.filter(
    (r) => !prev.relationships.some((p) => p.src === r.src && p.dst === r.dst && p.predicate === r.predicate),
  );
  const removedRelationships = prev.relationships.filter(
    (p) => !fresh.relationships.some((r) => r.src === p.src && r.dst === p.dst && r.predicate === p.predicate),
  );
  const addedEvidence = fresh.evidence.filter((e) => !prev.evidence.some((p) => p.id === e.id));
  const removedEvidence = prev.evidence.filter((p) => !fresh.evidence.some((e) => e.id === p.id));
  const addedClaims = fresh.claims.filter((c) => !prev.claims.some((p) => p.id === c.id));
  const removedClaims = prev.claims.filter((p) => !fresh.claims.some((c) => c.id === p.id));

  // Read off the bundle that was actually built, not restated from the
  // argument that built it. `{ ...saved.bundle.budgets }` would assert how the
  // fresh side was constructed rather than report it: today the two agree, but
  // letting CLI overrides win would mean editing the `buildFreshBundle` call in
  // the action handler, and `effective` would go on reporting the saved budget
  // while the fresh side used another one -- the silent misreport this record
  // exists to prevent. `ContextBundle.budgets` records the truth on both sides.
  const effective: BudgetSnapshot = { ...fresh.budgets };
  // Whether the caller's --max-* flags governed the fresh side.
  //
  // Not `requested equals effective`. Equal numbers are not evidence of
  // causation: `--max-evidence 25` against a saved budget of 25 produces
  // identical values while the flag changed nothing, and reporting `true` there
  // told an agent its override had taken -- so it raised the number, got the
  // saved budget again and now `false`. Three formats of one command disagreed,
  // because the note printed beside it said the opposite.
  //
  // What decides this is which budget the action handler hands
  // `buildFreshBundle`, and that is `saved.bundle.budgets` unconditionally, one
  // call site named in the comment there. So this is false, and the day that
  // call changes it is the day this needs to change with it.
  const requestedApplied = false;

  return {
    schema: "ix-investigation-diff/1",
    investigation: saved.id,
    savedAt: saved.savedAt,
    generatedAt: new Date().toISOString(),
    target: fresh.target,
    freshness: { previous: prev.freshness, current: fresh.freshness },
    budgets: {
      saved: saved.bundle.budgets,
      requested: requestedBudgets,
      effective,
      // The same fact the llm record carries as `applied=`. It was prose only
      // here, so a JSON consumer had to string-match a sentence whose wording
      // changed with the case, while the llm consumer got a boolean it could
      // test. One contract, both formats.
      requestedApplied,
      // Prose for the human reading the JSON, and only when there is something
      // to explain: without --max-* flags the sentence said nothing.
      ...(requestedBudgets
        ? {
            note: "Saved investigation budgets govern --diff; the --max-* flags recorded here were not applied to the fresh side.",
          }
        : {}),
    },
    added: {
      entities: addedEntities,
      relationships: addedRelationships,
      evidence: addedEvidence,
      claims: addedClaims,
    },
    removed: {
      entities: removedEntities,
      relationships: removedRelationships,
      evidence: removedEvidence,
      claims: removedClaims,
    },
  };
}

interface InvestigationDiff {
  schema: string;
  investigation: string;
  savedAt: string;
  generatedAt: string;
  target: ContextBundle["target"];
  freshness: { previous: ContextBundle["freshness"]; current: ContextBundle["freshness"] };
  budgets: {
    saved: BudgetSnapshot;
    requested?: Partial<BudgetSnapshot>;
    effective: BudgetSnapshot;
    /** Did `requested` govern the fresh side? The testable form of `note`. */
    requestedApplied: boolean;
    /** Present only when `requested` is: without it there is nothing to explain. */
    note?: string;
  };
  added: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
  removed: { entities: ContextBundle["entities"]; relationships: ContextBundle["relationships"]; evidence: EvidenceItem[]; claims: ContextBundle["claims"] };
}

/** Which side of a comparison a record is on, or neither for a plain bundle. */
type RecordChange = "added" | "removed" | undefined;

/**
 * The `entity`, `evidence` and `claim` records, built in one place.
 *
 * `ix context <target> --format llm` and `ix context --diff <id> --format llm`
 * are the same command and emitted two different grammars for the same record
 * kind: the bundle renderer built `evidence 30 relationship <title>` from a
 * template literal, positional and unquoted, so a title with a space in it —
 * which is every title — split into tokens no consumer could reassemble. These
 * builders are the keyed form, and `llmQuote` handles the spaces and newlines.
 *
 * `change` is dropped when absent (`llmField` drops nullish), so the plain
 * bundle emits the same record without it.
 */
function entityRecord(change: RecordChange) {
  return (e: ContextBundle["entities"][number]): string =>
    llmLine("entity", {
      change,
      // Relationship records name their endpoints by entity id, so this is
      // what lets a reader resolve `src=`/`dst=` to something it has seen.
      // Shortened on both sides of that reference, so it still resolves.
      id: llmShortId(e.id),
      kind: e.kind,
      name: e.name,
      path: e.path,
      // Only when true: `stale=false` on every entity is noise, and `llmField`
      // renders a boolean rather than dropping it.
      stale: e.stale || undefined,
    });
}

function evidenceRecord(change: RecordChange) {
  return (e: EvidenceItem): string =>
    llmLine("evidence", {
      change,
      score: e.score,
      kind: e.kind,
      title: e.title,
      path: e.location?.path,
      lines: e.location ? lineRange(e.location) : undefined,
    });
}

function claimRecord(change: RecordChange) {
  return (c: ContextBundle["claims"][number]): string =>
    llmLine("claim", {
      change,
      id: llmShortId(c.id),
      entity: llmShortId(c.entityId),
      status: c.status,
      statement: c.statement,
    });
}

export function renderInvestigationDiff(
  saved: SavedInvestigation,
  fresh: ContextBundle,
  format: string,
  requestedBudgets?: Partial<BudgetSnapshot>,
): void {
  const prev = saved.bundle;
  const diff = diffInvestigations(saved, fresh, requestedBudgets);

  if (format === "json") {
    printJson(diff);
    return;
  }
  if (format === "llm") {
    // `ix context --diff --format llm` used to fall through to the prose
    // renderer below, because this path only branched on `json`. That made the
    // most common agent path the worst one: escaping the prose is what `llm`
    // exists for.
    //
    // Every line goes through `llmLine`, never a template literal. The values
    // here are the ones most likely to contain a space in the whole CLI — an
    // evidence title is a sentence, and a claim id carries the statement — and
    // `key=value` with an unquoted space is not a record a consumer can split.
    // `llmQuote` also encodes newlines, so a title cannot break the one
    // record per line invariant.
    printLlmLines([
      llmLine("diff", {
        investigation: saved.id,
        target: fresh.target.name,
        // How old the saved side is. `freshness_previous=current` says the
        // snapshot was fresh when it was taken, not when that was — and a
        // snapshot from five minutes ago and one from three months ago are the
        // same word. Both timestamps are on the JSON diff; only the prose
        // renderer showed them, so the llm stream was the one surface that
        // could not tell how stale the comparison's own baseline is.
        saved_at: diff.savedAt,
        generated_at: diff.generatedAt,
        freshness_previous: prev.freshness.classification,
        freshness_current: fresh.freshness.classification,
      }),
      // Which budgets governed the comparison. `scope=requested` appears
      // only when --max-* flags were passed, and carries `applied=` rather
      // than a sentence explaining itself: the precedence rule is that saved
      // budgets govern --diff, and a field an agent can test beats a note it
      // has to read. `effective` is read off the bundle that was built, so it
      // is a report and not a restatement of `saved`.
      llmLine("budgets", { scope: "saved", ...budgetFields(diff.budgets.saved) }),
      ...(diff.budgets.requested
        ? [llmLine("budgets", {
            scope: "requested",
            ...budgetFields(diff.budgets.requested),
            applied: diff.budgets.requestedApplied,
          })]
        : []),
      llmLine("budgets", { scope: "effective", ...budgetFields(diff.budgets.effective) }),
      // One record rather than eight, and the zeros are kept: "nothing was
      // added" is the answer to the question `--diff` was asked, so dropping
      // it as a default would remove the signal.
      llmLine("count", {
        added_entities: diff.added.entities.length,
        removed_entities: diff.removed.entities.length,
        added_relationships: diff.added.relationships.length,
        removed_relationships: diff.removed.relationships.length,
        added_evidence: diff.added.evidence.length,
        removed_evidence: diff.removed.evidence.length,
        added_claims: diff.added.claims.length,
        removed_claims: diff.removed.claims.length,
      }),
      // `change=` rather than a `+`/`-` prefix on the record kind: a consumer
      // routing on the kind should still match `entity` on both sides of the
      // comparison, and a fused marker means it matches neither.
      //
      // `id=` on entities is what makes the stream joinable. Relationship
      // records name their endpoints by entity id, so without it
      // `relationship src=entity-1 dst=entity-2` resolves to nothing a reader
      // has seen and an added entity cannot be matched to the edge that
      // involves it. `--format json` loses none of this, and llm carrying less
      // than the format it is meant to replace is the wrong trade.
      ...diff.added.entities.map(entityRecord("added")),
      ...diff.removed.entities.map(entityRecord("removed")),
      ...diff.added.relationships.map((r) => llmLine("relationship", { change: "added", src: llmShortId(r.src), pred: r.predicate, dst: llmShortId(r.dst) })),
      ...diff.removed.relationships.map((r) => llmLine("relationship", { change: "removed", src: llmShortId(r.src), pred: r.predicate, dst: llmShortId(r.dst) })),
      ...diff.added.evidence.map(evidenceRecord("added")),
      ...diff.removed.evidence.map(evidenceRecord("removed")),
      // `statement=` is the field that says what changed. The id is the
      // backend's (`c-8f31a2`), so `claim change=added id=c-8f31a2
      // status=active` told a reader that a claim changed and not what it
      // says. The test fixture hid it by fabricating `claim-<statement>` ids.
      ...diff.added.claims.map(claimRecord("added")),
      ...diff.removed.claims.map(claimRecord("removed")),
    ]);
    return;
  }

  renderSection(`Investigation diff: ${saved.id}`);
  console.log(`  freshness: ${prev.freshness.classification} -> ${fresh.freshness.classification}`);
  // Prose only: `--format llm` returned above with records of its own. The
  // llm branch here used to be this same block with the colons moved, which
  // is the one thing the format is defined not to be.
  console.log(`  budgets:`);
  console.log(`    saved     : ${formatBudgets(diff.budgets.saved)}`);
  if (diff.budgets.requested) {
    console.log(`    requested : ${formatBudgets(diff.budgets.requested, true)}`);
  } else {
    console.log(`    requested : (none)`);
  }
  console.log(`    effective : ${formatBudgets(diff.budgets.effective)}`);
  console.log(`  entities:  -${diff.removed.entities.length} +${diff.added.entities.length}`);
  console.log(`  relationships: -${diff.removed.relationships.length} +${diff.added.relationships.length}`);
  console.log(`  evidence:  -${diff.removed.evidence.length} +${diff.added.evidence.length}`);
  console.log(`  claims:    -${diff.removed.claims.length} +${diff.added.claims.length}`);
  if (diff.added.entities.length > 0) {
    renderSection("Added entities");
    for (const e of diff.added.entities) console.log(`  ${e.name} (${e.kind})`);
  }
  if (diff.removed.entities.length > 0) {
    renderSection("Removed entities");
    for (const e of diff.removed.entities) console.log(`  ${e.name} (${e.kind})`);
  }
  if (diff.added.evidence.length > 0) {
    renderSection("Added evidence");
    for (const e of diff.added.evidence) console.log(`  [${e.score}] ${e.kind} - ${e.title}`);
  }
  if (diff.removed.evidence.length > 0) {
    renderSection("Removed evidence");
    for (const e of diff.removed.evidence) console.log(`  [${e.score}] ${e.kind} - ${e.title}`);
  }
  console.log();
}

interface BuildInput {
  resolved: { id: string; name: string; kind: string; resolutionMode: string };
  facts: ContextFacts;
  context: StructuredContext;
  provenance: unknown;
  asOfRev?: number;
  depth?: string;
  budgets: BudgetSnapshot;
  /**
   * Per-entity staleness probe. Injected so buildBundle stays a pure function
   * under test; production passes nothing and gets the real baseline-backed one.
   */
  isStale?: (path: string) => boolean;
  /**
   * Whether the workspace has a completed source graph baseline. Injected for the same
   * reason as `isStale`: it is a filesystem question, and buildBundle stays
   * pure under test. Both production callers pass the real answer; the default
   * is the optimistic one so a bundle built from injected facts alone is not
   * silently reclassified.
   */
  graphCompleted?: boolean;
  /**
   * The graph-health verdict (graph-health.ts), workspace-wide. The target's
   * own structure is judged here from `facts`. Absent under test and when the
   * check could not run, which says nothing.
   */
  graphHealth?: GraphHealth;
  /** Set by `--from-issue`: the starting points and the ranked files. */
  issue?: IssueBundleInput;
}

/** What `--from-issue` records in the bundle. */
interface IssueSummary {
  startingPoints: StartingPoint[];
  unresolved: string[];
  /** Nothing in the issue resolved; the start is BM25's best file. */
  fallback: boolean;
}

export interface IssueBundleInput extends IssueSummary {
  rankedFiles: RankedFile[];
  /** The other starting points' related files, entered as entities. */
  extraEntities?: EntityLocation[];
}

/**
 * The facts a bundle is built from: one hop from `collectFacts`, then the
 * ranked files two hops out, which are seeded from those facts. The second
 * step is best-effort -- a bundle without it is the bundle `ix context` built
 * before it existed, and failing the command over it would be a regression.
 */
async function collectContextFacts(
  client: IxClient,
  resolved: { id: string; name: string; kind: string },
): Promise<ContextFacts> {
  const facts = await collectFacts(client, resolved.id, resolved.name, resolved.kind, "context");
  const graphRefs = await collectRelatedFiles(client, resolved, facts).catch(() => []);
  const textRefs = await collectTextRelated(client, facts, graphRefs).catch(() => []);
  const history = await collectHistory(client, facts, [...graphRefs, ...textRefs]).catch(() => undefined);
  // Added to the graph's files, not ranked against them. Put first and sharing
  // the eight slots, they displaced graph finds the benchmark needed
  // (`main.ts` for `mcp/runner.ts`) with mentions that led nowhere.
  const relatedRefs = [...graphRefs.slice(0, MAX_RELATED), ...textRefs, ...(history?.coChanged ?? [])];
  return {
    ...facts,
    ...(relatedRefs.length > 0 ? { relatedRefs } : {}),
    ...(history?.recent.length ? { recentCommits: history.recent } : {}),
  };
}

/**
 * The target file's recent commits, and the files that changed with it. From
 * the working tree's git, so absent outside a checkout. See `explain/history.ts`.
 */
async function collectHistory(
  client: IxClient,
  facts: ContextFacts,
  related: RelatedRef[],
): Promise<{ recent: CommitRef[]; coChanged: RelatedRef[] } | undefined> {
  if (!facts.path) return undefined;
  const git = gitRunner(resolveWorkspaceRoot());
  const known = new Set<string>([facts.path]);
  for (const ref of [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []), ...related,
  ]) {
    if (ref.path) known.add(ref.path);
  }
  const [recent, coChanges] = await Promise.all([recentCommits(git, facts.path), coChangedFiles(git, facts.path, known)]);
  const coChanged = await Promise.all(coChanges.map(async (c) => {
    const name = c.path.split("/").pop()!;
    const id = await fileNodeId(client, c.path);
    const named = `changed with the target in ${c.commits} commits`;
    return { id, name, kind: "file", path: c.path, score: c.score, reason: named, via: [], named };
  }));
  return { recent, coChanged };
}

/**
 * A file's graph node id, for an entity the rest of the bundle can refer to.
 * Scoped: a backend holding two checkouts of one repository has two. Falls
 * back to a synthetic id rather than dropping a file the graph has not seen.
 */
async function fileNodeId(client: IxClient, path: string): Promise<string> {
  return (await findFileNode(client, path)) ?? `file:${path}`;
}

/**
 * Search candidates for one file node. `scope` narrows the search to the path
 * on a backend that applies it (Ix-memory >= 1.0.31); an older one ignores it
 * and returns every file sharing the basename, so the limit has to reach past
 * a monorepo's `index.ts`, `__init__.py` or `mod.rs` -- at 10 a file ranked
 * eleventh among its namesakes had no node, and `--from-issue` discarded a path
 * the issue named for a BM25 guess.
 */
const FILE_NODE_SEARCH_LIMIT = 200;

/** A file's graph node id, or undefined when the graph has no node for it. */
export async function findFileNode(client: IxClient, path: string): Promise<string | undefined> {
  const name = path.split("/").pop()!;
  const nodes = await client.search(name, {
    kind: "file", nameOnly: true, limit: FILE_NODE_SEARCH_LIMIT, scope: path, ...activeReadScope(),
  }).catch(() => []);
  return nodes.find((n) => relativePath(n.provenance?.sourceUri) === path)?.id;
}

/** Search candidates fetched per name the issue mentions; only exact names are kept. */
const ISSUE_SEARCH_LIMIT = 20;

/**
 * `ix context --from-issue`: a bundle built from an issue's text rather than a
 * named target. See `explain/issue.ts` for how starting points are chosen and
 * files ranked.
 *
 * The bundle is centred on the first starting point the graph has a node for,
 * built exactly as `ix context <that target>` would be. The other starting
 * points enter it as entities, with their own related files, and every
 * starting point's neighbourhood feeds the closeness that nudges the ranking.
 * Their facts are collected without text references or git history: those
 * are the expensive, centre-only parts of `collectContextFacts`.
 */
async function buildIssueBundle(
  arg: string,
  opts: ContextOptions,
  budgets: BudgetSnapshot,
): Promise<ContextBundle | undefined> {
  const text = await readIssueOrReport(arg, opts.format);
  if (text === undefined) return undefined;
  const client = createClient({ query: true });
  const plan = await planIssueWith(client, text);
  // A path start has no node yet, and the graph may not have one either: it
  // does not index every tracked file. chooseCentre walks BM25 for one it does.
  const { starts, centre, walked } = await chooseCentre(
    plan.starts, plan.bm25, (path) => findFileNode(client, path));
  if (!centre) {
    issueFailure(
      "issue_unresolved",
      starts.length === 0
        ? `Nothing the issue names resolved to a definition${plan.unresolved.length > 0 ? ` (tried ${plan.unresolved.slice(0, 5).join(", ")})` : ""}, and no tracked source file matched its text. Name a symbol or file and run ix context <target>.`
        : `Neither the issue's starting points (${starts.map((s) => s.path).join(", ")}) nor the ${CENTRE_FALLBACK_TRIES} source files that best match its text are in the graph. Name a symbol or file and run ix context <target>, or run ix map if this workspace has not been mapped.`,
      opts.format,
    );
    return undefined;
  }
  const resolved = { id: centre.id!, name: centre.name, kind: centre.kind, resolutionMode: "issue" };
  const [facts, context, around, workspaceHealth] = await Promise.all([
    collectContextFacts(client, resolved),
    client.contextForNode(resolved.id, { asOfRev: opts.asOfRev, depth: opts.depth }),
    Promise.all(starts.filter((s) => s.id && s !== centre).map((s) => startNeighbourhood(client, s))),
    checkGraphHealth(client, activeReadScope()),
  ]);

  const near = new Map<string, Closeness>();
  const mark = (path: string | undefined, weight: number, reason: string) => {
    if (!path) return;
    const prior = near.get(path);
    if (!prior || weight > prior.weight) near.set(path, { weight, reason });
  };
  for (const n of [{ start: centre, facts, related: facts.relatedRefs ?? [] }, ...around]) {
    for (const ref of oneHopRefs(n.facts)) {
      if (ref.path !== n.start.path) mark(ref.path, 1, `one hop from ${n.start.name}`);
    }
    for (const ref of n.related) mark(ref.path, 0.5, `near ${n.start.name}`);
  }

  return buildBundle({
    resolved,
    facts,
    context,
    provenance: facts.provenance,
    asOfRev: opts.asOfRev,
    depth: opts.depth,
    budgets,
    graphCompleted: hasCompletedSourceGraphBaseline(),
    graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
    issue: {
      startingPoints: starts,
      unresolved: plan.unresolved,
      fallback: plan.fallback || walked,
      rankedFiles: rankIssueFiles({ starts, bm25: plan.bm25, near }),
      extraEntities: around.flatMap((n) => n.related),
    },
  });
}

/** The issue's text, or undefined after reporting why it has none. */
async function readIssueOrReport(arg: string, format: string | undefined): Promise<string | undefined> {
  let text: string;
  try {
    text = await readIssueText(arg);
  } catch (error) {
    issueFailure(
      "issue_unreadable",
      `Cannot read the issue from ${arg === "-" ? "stdin" : `"${arg}"`}: ${(error as Error).message}`,
      format,
    );
    return undefined;
  }
  if (!text.trim()) {
    issueFailure("empty_issue", `The issue ${arg === "-" ? "on stdin" : `in "${arg}"`} is empty.`, format);
    return undefined;
  }
  return text;
}

/** The issue's starting points and lexical ranking, against this workspace's graph. */
async function planIssueWith(client: IxClient, text: string) {
  await ensureReadScope(client);
  const scope = activeReadScope();
  const root = resolveWorkspaceRoot();
  return planIssue(text, {
    repo: gitRepoAccess(root),
    // Through the on-disk term index (bm25-cache.ts): the same ranking, with
    // only the files that differ from HEAD read again.
    rank: cachedBm25Ranker(root),
    search: async (name) =>
      (await client.search(name, { limit: ISSUE_SEARCH_LIMIT, nameOnly: true, ...scope })).map(symbolHit),
  });
}

/**
 * `ix context --from-issue --lean`: the starting points Ix trusts and the
 * next few files, with no bundle around them. See `leanIssueView` for why.
 * Nothing here needs a centre node, so it is also the cheap path: one search
 * per name the issue mentions, and BM25 over the tracked files.
 */
async function emitLeanIssue(arg: string, opts: ContextOptions): Promise<void> {
  const text = await readIssueOrReport(arg, opts.format);
  if (text === undefined) return;
  const view = leanIssueView(await planIssueWith(createClient({ query: true }), text));
  if (opts.format === "json") {
    printJson({ kind: "issue_lean", ...view });
  } else if (opts.format === "llm") {
    printLlmLines(renderLeanIssueLlm(view));
  } else {
    console.log(renderLeanIssueText(view));
  }
}

function spanOf(s: StartingPoint): string {
  return s.lineStart !== undefined ? `${s.path}:${s.lineStart}-${s.lineEnd ?? s.lineStart}` : s.path;
}

/** Why a start was trusted, in the words an agent reads. */
function startWhy(s: StartingPoint): string {
  return s.via === "path in issue" ? "the issue names this file" : `the issue names \`${s.token}\``;
}

export function renderLeanIssueText(view: LeanIssueView): string {
  if (view.confidence === "low") {
    return `Ix found no confident starting point for this issue: ${view.reason}.`;
  }
  const lines = ["Where to start (Ix resolved these from the issue's own words):"];
  for (const s of view.startingPoints) {
    lines.push(`  ${spanOf(s)}  ${s.kind === "file" ? "" : `${s.name} (${s.kind}) — `}${startWhy(s)}`);
  }
  if (view.alsoRanked.length > 0) {
    lines.push(`Then, by the issue's text: ${view.alsoRanked.map((f) => f.path).join(", ")}`);
  }
  return lines.join("\n");
}

export function renderLeanIssueLlm(view: LeanIssueView): string[] {
  const out = [llmLine("issue", [
    ["confidence", view.confidence],
    ...(view.reason ? [["reason", view.reason] as [string, string]] : []),
  ])];
  for (const s of view.startingPoints) {
    out.push(llmLine("start", [
      ["path", s.path],
      ...(s.lineStart !== undefined ? [["lines", `${s.lineStart}-${s.lineEnd ?? s.lineStart}`] as [string, string]] : []),
      ["name", s.name], ["kind", s.kind], ["why", startWhy(s)],
    ]));
  }
  for (const f of view.alsoRanked) out.push(llmLine("ranked", [["path", f.path]]));
  return out;
}

/**
 * A `--from-issue` failure, readable by the format asked for. `reportFailure`
 * writes nothing to stdout under `--format json`, so a JSON caller got an empty
 * stdout and had to scrape stderr; this prints the record the other commands'
 * JSON failures use.
 */
function issueFailure(code: string, message: string, format: string | undefined): void {
  if (format === "json") {
    printJson({ error: code, message });
    process.exitCode = 1;
    return;
  }
  reportFailure(code, message, format);
}

/** A secondary starting point's one-hop facts and related files. Best-effort. */
async function startNeighbourhood(
  client: IxClient,
  start: StartingPoint,
): Promise<{ start: StartingPoint; facts?: ContextFacts; related: RelatedRef[] }> {
  try {
    const facts = await collectFacts(client, start.id!, start.name, start.kind, "context");
    const related = await collectRelatedFiles(client, { id: start.id!, kind: start.kind }, facts).catch(() => []);
    return { start, facts, related };
  } catch {
    return { start, related: [] };
  }
}

/** What a target reaches, and what reaches it, one step out. */
function oneHopRefs(facts: ContextFacts | undefined): EntityLocation[] {
  if (!facts) return [];
  return [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []),
  ];
}

/** A search result as the starting-point picker reads it. */
function symbolHit(node: GraphNode): SymbolHit {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const line = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const lineStart = line(attrs.line_start);
  const lineEnd = line(attrs.line_end);
  return {
    id: node.id,
    name: node.name || (typeof attrs.name === "string" ? attrs.name : ""),
    kind: node.kind || "unknown",
    path: relativePath(node.provenance?.sourceUri),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
  };
}

/** Imported files whose text is read for names, after the target's own. */
const TEXT_SOURCE_IMPORTS = 8;

/**
 * Files linked to the target by text rather than by any graph edge: a path in
 * a string (`"../../../../core-ingestion/dist/languages.js"`), a file named
 * in a comment, a test that reads a file by path. Read from the working tree,
 * so skipped outside a git checkout. See `collectTextReferences`.
 */
async function collectTextRelated(
  client: IxClient,
  facts: ContextFacts,
  graphRefs: RelatedRef[],
): Promise<RelatedRef[]> {
  if (!facts.path) return [];
  const repo = gitRepoAccess(resolveWorkspaceRoot());
  if (!repo) return [];
  const sources: TextSource[] = [
    { path: facts.path, role: "target" },
    ...(facts.importRefs ?? [])
      .filter((ref) => ref.kind === "file" && ref.path)
      .slice(0, TEXT_SOURCE_IMPORTS)
      .map((ref) => ({ path: ref.path!, role: "import" as const })),
  ];
  const known = new Set<string>();
  for (const ref of [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []), ...graphRefs,
  ]) {
    if (ref.path) known.add(ref.path);
  }
  const found = collectTextReferences(repo, sources, known);
  return Promise.all(found.map(async (ref): Promise<RelatedRef> => ({
    id: await fileNodeId(client, ref.path), name: ref.path.split("/").pop()!, kind: "file", path: ref.path,
    score: ref.score, reason: ref.reason, via: [], named: ref.reason,
  })));
}

/**
 * The workspace verdict, made worse by the target's own structure when a
 * definition no file contains shows its edges are gone even though the
 * workspace as a whole looks fine (only some files re-ingested elsewhere).
 */
function bundleGraphHealth(
  workspace: GraphHealth,
  resolved: { name: string; kind: string },
  facts: { path?: string; container?: unknown },
): GraphHealth {
  return worseHealth(workspace, assessTargetStructure({
    name: resolved.name, kind: resolved.kind, path: facts.path, container: facts.container,
  }));
}

export function buildBundle(input: BuildInput): ContextBundle {
  const { resolved, facts, context, provenance, asOfRev, depth, budgets } = input;

  const stale = facts.stale;
  // Three states, not two. Without a completed source graph baseline the
  // backend may still answer from partially committed graph patches. It is not
  // `stale` either — nothing is known to have changed. The
  // freshness union has carried `unverified` for exactly this case since it was
  // written; this is the first thing to produce it.
  const graphCompleted = input.graphCompleted ?? true;
  // A hollowed graph outranks all three: "current" would vouch for a bundle
  // whose members and callers the graph has lost.
  const health = input.graphHealth;
  const degraded = isUnhealthy(health);
  const classification = degraded ? "degraded" : !graphCompleted ? "unverified" : stale ? "stale" : "current";
  const prov = provenanceSource(provenance);

  // Entities: the target itself plus every referenced node, deduped by id and
  // ordered deterministically (kind, name, id) before budgeting.
  // `stale` here is the TARGET's staleness, from the facts collector. It is
  // right for the bundle-level `freshness`, but every other entity has to be
  // asked about separately — stamping the target's answer onto all of them
  // reported an untouched dependency as stale whenever the target was, and a
  // genuinely stale one as current whenever the target was not. Staleness is
  // the field an agent reads to decide whether to trust the rest, so a wrong
  // one is worse than none.
  const seen = new Set<string>([resolved.id]);
  const entities: ContextBundle["entities"] = [
    {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      ...locationFields(targetLocation(facts) ?? {}),
      stale,
    },
  ];
  // The entities the facts collector located, most relevant first: the
  // top-ranked members, then the named callers and dependents. They go ahead of
  // the backend's context nodes, which are ordered by kind and name, so the
  // entity budget cuts what matters least. They also carry the paths and lines
  // that the backend's node summaries do not.
  //
  // Only the leading members jump the queue. A large file has more members than
  // the whole entity budget -- `ingest.ts` in the Ix repo has over a hundred --
  // and putting all of them first crowded out the files it imports and is
  // imported by, which are what cross-file questions need. The rest follow the
  // context nodes.
  const memberRefs = facts.memberRefs ?? [];
  const pushLocated = (refs: EntityLocation[]) => {
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      entities.push({
        id: ref.id,
        name: ref.name,
        kind: ref.kind,
        // A package's provenance names the file that imports it, not the
        // package: `node:fs` came out located in `commands/watch.ts`.
        ...(ref.kind === "module" ? {} : locationFields(ref)),
        stale: false, // replaced below, for the entities that survive the budget
      });
    }
  };
  const issue = input.issue;
  pushLocated([
    // The issue's other starting points, right after the one the bundle is
    // centred on: they are as much the target as it is.
    ...(issue?.startingPoints ?? [])
      .filter((s) => s.id && s.id !== resolved.id)
      .map((s) => ({ id: s.id!, name: s.name, kind: s.kind, ...locationFields(s) })),
    ...memberRefs.slice(0, LEADING_MEMBERS),
    // What the target reaches, before what reaches it: an agent starting from
    // an entry point is looking for where to go next.
    ...(facts.importRefs ?? []),
    ...(facts.calleeRefs ?? []),
    // What those files define. Naming the file is half an answer to "which
    // function does X"; these are the other half.
    ...(facts.neighbourRefs ?? []),
    ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []),
    // Two steps out, ranked. After everything one step out, and ahead of the
    // backend's context nodes, which are ordered by kind and name only.
    ...(facts.relatedRefs ?? []),
    ...(issue?.extraEntities ?? []),
  ]);
  // Compact and standard backend responses omit the full graph arrays and
  // carry the same graph as summaries. Falling back here keeps the default
  // context mode from collapsing to a target-only bundle.
  const contextNodes = context.nodes.length > 0
    ? context.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: node.provenance?.sourceUri,
      }))
    : (context.nodeSummaries ?? []).map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: node.path ?? node.sourceUri ?? undefined,
      }));
  // The facts collector's own record of an entity wins over the backend's
  // summary of it. Backends up to at least 1.0.30 summarize a file's members
  // with the FILE's name and no path, so a member that reached the bundle
  // through the summaries -- ahead of its located ref, which `seen` then
  // skipped -- came out as twelve entities all named `watch.ts`.
  const trailingMembers = memberRefs.slice(LEADING_MEMBERS);
  const locatedById = new Map(trailingMembers.map((ref) => [ref.id, ref]));
  const fileNames = new Set(
    [...contextNodes, resolved].filter((n) => n.kind === "file").map((n) => n.name));
  for (const node of orderedNodes(contextNodes)) {
    if (seen.has(node.id)) continue;
    const located = locatedById.get(node.id);
    if (located) {
      pushLocated([located]);
      continue;
    }
    // The same defect with no located ref to fall back on: a symbol with no
    // location, named after a file. Its name is wrong and it cannot be
    // opened, so it would only spend entity budget misleading the reader.
    if (!node.path && node.kind !== "file" && node.kind !== "module" && fileNames.has(node.name)) {
      continue;
    }
    seen.add(node.id);
    entities.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(node.kind === "module" || !node.path ? {} : { path: node.path }),
      stale: false, // replaced below, for the entities that survive the budget
    });
  }
  pushLocated(trailingMembers);

  // Relationships: graph edges, ordered deterministically.
  const contextEdges = context.edges.length > 0 ? context.edges : (context.edgeSummaries ?? []);
  const relationships = [...contextEdges]
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.predicate, b.predicate))
    .map((edge) => ({ src: edge.src, dst: edge.dst, predicate: edge.predicate }));

  const evidence = rankEvidence({ resolved, facts, context, relationships, prov, entities, issue });

  const bundle: ContextBundle = {
    schema: BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    target: {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      resolutionMode: resolved.resolutionMode,
      ...(facts.path ? { path: facts.path } : {}),
    },
    ...(issue
      ? {
          issue: { startingPoints: issue.startingPoints, unresolved: issue.unresolved, fallback: issue.fallback },
          rankedFiles: issue.rankedFiles,
        }
      : {}),
    entities: [],
    relationships: [],
    claims: [...context.claims]
      .sort(
        (a, b) =>
          cmp(a.claim.entityId, b.claim.entityId) ||
          cmp(a.claim.statement, b.claim.statement) ||
          cmp(a.claim.id, b.claim.id),
      )
      .map((scored) => ({
        id: scored.claim.id,
        entityId: scored.claim.entityId,
        statement: scored.claim.statement,
        status: scored.claim.status,
      })),
    decisions: [...context.decisions].sort((a, b) => cmp(a.title, b.title) || a.rev - b.rev || cmp(a.rationale, b.rationale)),
    conflicts: [...context.conflicts].sort((a, b) => cmp(a.claimA, b.claimA) || cmp(a.claimB, b.claimB) || cmp(a.id, b.id)),
    intents: [...context.intents].sort((a, b) => cmp(a.statement, b.statement) || cmp(a.id, b.id)),
    provenance: {
      sourceUri: asString(prov.sourceUri) ?? facts.path,
      sourceHash: asString(prov.sourceHash),
      extractor: asString(prov.extractor),
      sourceType: asString(prov.sourceType),
      observedAt: asString(prov.observedAt),
      introducedRev: facts.introducedRev,
      historyLength: facts.historyLength,
      stale,
    },
    freshness: { stale, classification },
    ...(degraded ? { graph: graphHealthJson(health) } : {}),
    evidence: [],
    budgets,
    truncation: {
      entitiesTruncated: 0,
      relationshipsTruncated: 0,
      evidenceTruncated: 0,
      charactersTruncated: 0,
      conflictsTruncated: 0,
    },
    metadata: {
      asOfRev,
      depth,
      rankingRule: "deterministic-tier",
    },
  };

  // Apply budgets with explicit truncation metadata. Ordering is already
  // deterministic, so cutting from the tail is stable across runs.
  const entityLimit = Math.min(entities.length, budgets.maxEntities);
  // Probe staleness after budgeting, so the cost is bounded by maxEntities
  // rather than by however many nodes the context service returned. The target
  // keeps the answer the facts collector already produced for it.
  const probeStale = input.isStale ?? createStaleProbe();
  bundle.entities = entities.slice(0, entityLimit).map((entity) =>
    entity.id === resolved.id || !entity.path
      ? entity
      : { ...entity, stale: probeStale(entity.path) },
  );
  bundle.truncation.entitiesTruncated = entities.length - entityLimit;

  // Relationships are budgeted against the entities that SURVIVED, not against
  // the full list. The two budgets used to be applied independently, so an edge
  // could be kept while one or both of its endpoints were cut: measured on a
  // real target at `--max-entities 10`, 59 of 74 relationships referenced an
  // entity no longer in the bundle, 13 of them at both ends -- and
  // `relationshipsTruncated` reported 0, because nothing had exceeded the
  // relationship budget. The renderer prints those as bare UUIDs, so the damage
  // was invisible.
  //
  // The backend already guarantees this on its side (`trimSlice` keeps an edge
  // only when both endpoints survive); this stops the CLI from undoing it.
  // Dropping the dangling edge rather than pulling its endpoint back in keeps
  // `--max-entities` meaning exactly what it says.
  const keptEntityIds = new Set(bundle.entities.map((e) => e.id));
  const connected = relationships.filter(
    (r) => keptEntityIds.has(r.src) && keptEntityIds.has(r.dst),
  );
  const relLimit = Math.min(connected.length, budgets.maxRelationships);
  bundle.relationships = connected.slice(0, relLimit);
  // Count everything the caller does not get back, whichever budget cost it --
  // the entity cut and the relationship cut both drop relationships, and
  // reporting only the second is what made an 80%-dangling bundle look clean.
  bundle.truncation.relationshipsTruncated = relationships.length - relLimit;

  // Evidence is ordered by relevance, so keep the highest-priority prefix and
  // drop the tail when either the count or the character budget is exceeded.
  // maxChars bounds the serialized JSON size of the evidence list exactly as it
  // is emitted in the bundle (each item's JSON.stringify length, in the item's
  // deterministic key order), so the budget matches the actual representation
  // rather than an estimate from metadata lengths.
  const sizedEvidence = evidence.map((item) => ({ item, size: JSON.stringify(item).length }));
  let chars = 0;
  let kept = 0;
  for (const entry of sizedEvidence) {
    if (kept >= budgets.maxEvidence || chars + entry.size > budgets.maxChars) break;
    chars += entry.size;
    kept += 1;
  }
  bundle.evidence = evidence.slice(0, kept);
  bundle.truncation.evidenceTruncated = evidence.length - kept;
  const dropped = summariseCut(evidence.slice(kept));
  if (dropped.length > 0) bundle.truncation.cut = dropped;
  const fullChars = sizedEvidence.reduce((sum, entry) => sum + entry.size, 0);
  bundle.truncation.charactersTruncated = Math.max(0, fullChars - chars);

  // `conflicts[]` was the one list with no budget at all, and it is the one the
  // backend can hand back by the dozen: it reached 12,922 of 23,030 JSON bytes
  // on a recorded bundle. The evidence budgets never bounded it because they
  // bound `evidence`. Cap it at a fixed depth -- a caller who wants the full
  // set has `ix conflicts`, which is the command that renders them properly.
  const conflictLimit = Math.min(bundle.conflicts.length, MAX_CONFLICTS);
  bundle.truncation.conflictsTruncated = bundle.conflicts.length - conflictLimit;
  bundle.conflicts = bundle.conflicts.slice(0, conflictLimit);

  return bundle;
}

/** Deterministic evidence ranking: tier, then a stable id tiebreaker. */
function rankEvidence(input: {
  resolved: { id: string; name: string; kind: string };
  facts: ContextFacts;
  context: StructuredContext;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  prov: Record<string, unknown>;
  entities: ContextBundle["entities"];
  issue?: IssueBundleInput;
}): EvidenceItem[] {
  const items: EvidenceItem[] = [];

  const target = input.resolved;
  items.push({
    id: `target:${target.id}`,
    kind: "target",
    source: "resolution",
    title: `${target.name} (${target.kind})`,
    score: 0,
    reason: "resolved target — the bundle is centered on this entity",
    refs: [target.id],
    ...locationField(targetLocation(input.facts)),
  });
  // Straight after the target, ahead of everything structural: a file target
  // with many members fills the default budget before score 10 runs out, and
  // these two rows are what `--from-issue` exists to deliver.
  if (input.issue) items.push(...issueEvidence(input.issue));

  type Structural = Omit<EvidenceItem, "kind" | "score">;
  const structural: Structural[] = [];
  if (input.facts.container) {
    structural.push({
      id: `container:${input.facts.container.name}`,
      source: "facts.container",
      title: `container ${input.facts.container.name} (${input.facts.container.kind})`,
      reason: "contains the target",
      refs: [input.facts.container.id],
      ...locationField(input.facts.container),
    });
  }
  // Names alone when the facts carry no locations, so a caller that builds its
  // own facts (or an older collector) still gets the structural evidence.
  const related = (
    names: string[],
    refs: EntityLocation[] | undefined,
    limit: number,
  ): Array<{ name: string; ref?: EntityLocation }> =>
    (refs ? refs.map((ref) => ({ name: ref.name, ref })) : names.map((name) => ({ name }))).slice(0, limit);

  const leadingMembers = related(input.facts.members, input.facts.memberRefs, LEADING_MEMBERS);
  const pushMembers = (members: typeof leadingMembers) => {
    for (const { name, ref } of members) {
      structural.push({
        id: `member:${name}`, source: "facts.members", title: `member ${name}`,
        reason: ref ? memberReason(ref) : "defined in the target", refs: ref ? [ref.id] : [], ...locationField(ref),
      });
    }
  };
  // The most-used members first, the rest last. A file target's evidence at
  // the default budget was the target and its first ten members and nothing
  // else -- the part of a bundle an agent sees anyway the moment it opens the
  // target. Measured on ix-bench, 0.55 of the expected files were in the
  // bundle and 0.32 in the text an agent is shown.
  pushMembers(leadingMembers.slice(0, MEMBERS_BEFORE_OUTWARD));
  // Two steps out: a neighbour's import, or a file that depends on what the
  // target depends on. Before the imports, which the target's own header
  // lists; these are the files a one-hop bundle cannot name at all.
  //
  // One row for all of them. As a row each, five related files cost as much
  // of the evidence budget as five imports, and at the default budget the
  // imports then fell off the end instead: the files moved, the count the
  // agent could see did not.
  const relatedRefs = input.facts.relatedRefs ?? [];
  if (relatedRefs.length > 0) {
    structural.push({
      id: "related-files", source: "facts.related",
      title: `related files: ${relatedRefs.map((ref) => ref.path ?? ref.name).join(", ")}`,
      reason: `two steps from the target, ranked; ${relatedRefs.map(relatedClause).join("; ")}`,
      refs: relatedRefs.map((ref) => ref.id),
    });
  }
  // What happened to the target's file lately. The subjects carry what a
  // one-hop bundle cannot: that the sibling commands were already fixed for
  // the same condition, or that the same bug was fixed next door.
  const commits = input.facts.recentCommits ?? [];
  if (commits.length > 0) {
    const file = (input.facts.path ?? "").split("/").pop();
    structural.push({
      id: "recent-commits", source: "git.history",
      title: `recent commits to ${file}: ${commits.map((c) => `${c.sha} ${c.subject}`).join("; ")}`,
      reason: `newest first (${commits.map((c) => c.date).join(", ")}); \`git show <sha>\` for the change`,
      refs: [],
    });
  }
  // Then outward. The file an answer lives in is most often one the target
  // imports: measured on the benchmark task set, 6 of 19 tasks' answers are a
  // direct import of their entry point, and none were in the bundle. These go
  // after the target's own members, not before: the evidence budget is 25
  // items, and a file with many imports (resolve.ts) pushed all 27 of its own
  // members out of the bundle entirely.
  for (const ref of (input.facts.importRefs ?? []).slice(0, SHOWN_IMPORTS)) {
    structural.push({
      id: `imports:${ref.name}`, source: "facts.imports", title: `imports ${ref.name}`,
      reason: "the target imports this", refs: [ref.id], ...locationField(ref),
    });
  }
  for (const ref of input.facts.calleeRefs ?? []) {
    structural.push({
      id: `calls:${ref.name}`, source: "facts.callees", title: `calls ${ref.name}`,
      reason: "the target calls this", refs: [ref.id], ...locationField(ref),
    });
  }
  for (const ref of (input.facts.neighbourRefs ?? []).slice(0, SHOWN_NEIGHBOUR_MEMBERS)) {
    const where = ref.path ? ref.path.split("/").pop() : undefined;
    structural.push({
      id: `defines:${ref.path ?? ""}:${ref.name}`, source: "facts.neighbours",
      title: `${where ?? "a neighbouring file"} defines ${ref.name}`,
      reason: "defined in a file next to the target", refs: [ref.id], ...locationField(ref),
    });
  }
  for (const { name, ref } of related(input.facts.topCallers, input.facts.topCallerRefs, 3)) {
    structural.push({
      id: `caller:${name}`, source: "facts.callers", title: `caller ${name}`,
      reason: "calls the target", refs: ref ? [ref.id] : [], ...locationField(ref),
    });
  }
  for (const { name, ref } of related(input.facts.topDependents, input.facts.topDependentRefs, 3)) {
    structural.push({
      id: `dependent:${name}`, source: "facts.dependents", title: `dependent ${name}`,
      reason: "calls, imports or references the target", refs: ref ? [ref.id] : [], ...locationField(ref),
    });
  }
  pushMembers(leadingMembers.slice(MEMBERS_BEFORE_OUTWARD));
  structural.forEach((item, index) => {
    // Recent commits are provenance -- where the file's current shape came
    // from -- and keep to the stable kinds consumers already route on.
    items.push({ ...item, kind: item.source === "git.history" ? "provenance" : "structural", score: 10 + index });
  });

  for (const scored of input.context.claims) {
    items.push({
      id: `claim:${scored.claim.id}`,
      kind: "claim",
      source: "context.claims",
      title: scored.claim.statement,
      score: 20,
      reason: `context claim (relevance ${scored.relevance}, confidence ${scored.confidence?.score ?? "n/a"})`,
      refs: [scored.claim.entityId],
    });
  }
  for (const decision of input.context.decisions) {
    items.push({
      id: `decision:${decision.title}`,
      kind: "decision",
      source: "context.decisions",
      title: decision.title,
      score: 21,
      reason: decision.rationale,
      refs: decision.entityId ? [decision.entityId] : [],
    });
  }
  // Conflicts are deliberately NOT evidence. A report names its two claims by
  // uuid, which is nothing an agent can act on, and at score 22 they outranked
  // every relationship: on recorded bundles they were taking 12 to 17 of the 25
  // slots and truncating away the members and imports that answer the question.
  // The count is carried in the bundle header and the reports themselves stay
  // in `conflicts[]` for a caller that wants them; `ix conflicts` renders them.
  for (const intent of input.context.intents) {
    items.push({
      id: `intent:${intent.id}`,
      kind: "intent",
      source: "context.intents",
      title: intent.statement,
      score: 23,
      reason: `intent status ${intent.status}`,
      refs: [],
    });
  }

  const label = entityLabeller(input.entities);
  input.relationships.slice(0, 50).forEach((edge, index) => {
    items.push({
      id: `relationship:${edge.src}:${edge.dst}:${edge.predicate}`,
      kind: "relationship",
      source: "context.edges",
      title: `${label(edge.src)} --${edge.predicate}--> ${label(edge.dst)}`,
      score: 30 + Math.min(index, 10),
      reason: "graph relationship from the context service",
      refs: [edge.src, edge.dst],
    });
  });

  items.push({
    id: `provenance:${target.id}`,
    kind: "provenance",
    source: "provenance + facts.history",
    title: `history length ${input.facts.historyLength}, introduced rev ${input.facts.introducedRev ?? "unknown"}`,
    score: 40,
    reason: `provenance ${input.prov.sourceType ?? "unknown"}, extractor ${input.prov.extractor ?? "unknown"}`,
    refs: [target.id],
  });

  // Stable full ordering: score, then id.
  return items.sort((a, b) => a.score - b.score || cmp(a.id, b.id));
}

/** Ranked files named in the evidence row; the JSON bundle carries the rest. */
const SHOWN_RANKED_FILES = 10;

/**
 * The `--from-issue` rows: where the bundle starts and why, then the files to
 * read, ranked against the issue's text.
 */
function issueEvidence(issue: IssueBundleInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const starts = issue.startingPoints;
  if (starts.length > 0) {
    const unresolved = issue.unresolved.length > 0
      ? `; unresolved: ${issue.unresolved.slice(0, 8).join(", ")}${issue.unresolved.length > 8 ? ", ..." : ""}`
      : "";
    const why = starts.map((s) => `${s.token}: ${s.via}`).join("; ");
    items.push({
      id: "issue-starts",
      kind: "target",
      source: "issue.starts",
      title: `starting points: ${starts.map((s) => `${s.name} (${formatLocation(locationFields(s) as EvidenceLocation)})`).join(", ")}`,
      score: 1,
      reason: (issue.fallback
        ? "no code name in the issue resolved to a definition; starting from the file BM25 ranks first against the issue text; "
        : "") + why + unresolved,
      refs: starts.flatMap((s) => (s.id ? [s.id] : [])),
      ...locationField(starts[0]),
    });
  }
  const shown = issue.rankedFiles.slice(0, SHOWN_RANKED_FILES);
  if (shown.length > 0) {
    items.push({
      id: "issue-ranked-files",
      kind: "structural",
      source: "issue.ranking",
      title: `ranked files: ${shown.map((f) => f.path).join(", ")}`,
      score: 2,
      reason: `starting points first, then bm25 against the issue text, graph neighbours of a starting point boosted up to ${Math.round(CLOSENESS_BOOST * 100)}%; `
        + shown.map((f) => `${f.path.split("/").pop()} (${f.reason})`).join("; "),
      refs: [],
    });
  }
  return items;
}

export function renderBundle(bundle: ContextBundle, format: string): void {
  if (format === "json") {
    printJson(bundle);
    return;
  }
  if (format === "llm") {
    // Every line through `llmLine`, none through a template literal. This block
    // built `target=${name}` and `evidence 30 relationship <title>` by
    // interpolation: the first breaks on any name containing a space or an `=`,
    // and the second is positional, unquoted, and breaks on every title, which
    // is a sentence. `ix context --diff --format llm` emits the keyed form for
    // the same record kinds, so a consumer routing on `evidence` from the same
    // command was handed two grammars.
    printLlmLines([
      llmLine("context", {
        target: bundle.target.name,
        target_kind: bundle.target.kind,
        target_path: bundle.target.path,
        // Not on a degraded graph: `stale=false` there reads as a clean bill
        // of health for a bundle the graph has hollowed out.
        graph: bundle.graph ? String(bundle.graph.status) : undefined,
        stale: bundle.graph ? undefined : bundle.freshness.stale,
        classification: bundle.freshness.classification,
        entities: bundle.entities.length,
        relationships: bundle.relationships.length,
        claims: bundle.claims.length,
        decisions: bundle.decisions.length,
        conflicts: bundle.conflicts.length + bundle.truncation.conflictsTruncated,
        intents: bundle.intents.length,
        evidence: bundle.evidence.length,
        truncated_entities: bundle.truncation.entitiesTruncated,
        truncated_relationships: bundle.truncation.relationshipsTruncated,
        truncated_evidence: bundle.truncation.evidenceTruncated,
        truncated_chars: bundle.truncation.charactersTruncated,
      }),
      // First after the header: everything below is drawn from this graph.
      bundle.graph ? llmLine("graph", {
        status: asString(bundle.graph.status),
        reason: asString(bundle.graph.reason),
        message: asString(bundle.graph.message),
        fix: asString(bundle.graph.fix),
      }) : null,
      // What the budget dropped, and the cheapest command that gets it back.
      // The header's `truncated_*` counters say how much went; without this the
      // caller's only move is a bigger budget for the same query, which is the
      // most expensive one available.
      truncationAdvice(bundle)
        ? llmLine("diagnostic", { code: "bundle_truncated", message: truncationAdvice(bundle) })
        : null,
      bundle.issue?.fallback
        ? llmLine("diagnostic", { code: "issue_fallback", message: ISSUE_FALLBACK_NOTE })
        : null,
      // Evidence only, as before. The entity, relationship and claim lists are
      // deliberately still counts here: `--format llm` is the token-minimal
      // surface, the ranked evidence is what it exists to deliver, and
      // `--format json` carries the rest for a caller that wants it.
      ...bundle.evidence.map(evidenceRecord(undefined)),
      // Last, so it reads as the closing instruction it is.
      ...(forMcp()
        ? nextToolCalls(bundle).map((step) => llmLine("next", { cmd: step.cmd, why: step.why }))
        : nextReads(bundle).map((cmd) => llmLine("next", { cmd }))),
    ]);
    return;
  }

  renderSection(`Context: ${bundle.target.name}`);
  console.log(`  kind:          ${bundle.target.kind}`);
  if (bundle.target.path) console.log(`  path:          ${bundle.target.path}`);
  console.log(`  classification:${bundle.freshness.classification}`);
  console.log(`  entities:      ${bundle.entities.length}`);
  console.log(`  relationships: ${bundle.relationships.length}`);
  console.log(`  claims:        ${bundle.claims.length}`);
  console.log(`  decisions:     ${bundle.decisions.length}`);
  // Named, not listed: see rankEvidence. The hint is what makes the count
  // actionable, since the reports are no longer in the evidence list.
  const conflictCount = bundle.conflicts.length + bundle.truncation.conflictsTruncated;
  console.log(
    `  conflicts:     ${conflictCount}${conflictCount > 0 ? " (run ix conflicts to inspect)" : ""}`,
  );
  console.log(`  intents:       ${bundle.intents.length}`);
  if (bundle.issue) {
    console.log(
      `  from issue:    ${bundle.issue.startingPoints.length} starting point(s), ${bundle.rankedFiles?.length ?? 0} ranked files`,
    );
    if (bundle.issue.fallback) renderNote(ISSUE_FALLBACK_NOTE);
  }
  if (bundle.graph) {
    const g = bundle.graph;
    renderWarning(
      `Graph is ${String(g.status)}. ${g.message ? String(g.message) : ""}${g.fix ? ` Fix: ${String(g.fix)}` : ""}`.trim(),
    );
  }
  if (bundle.freshness.stale) {
    renderWarning("Source has changed since last ingest. Run ix map to update.");
  }

  if (bundle.evidence.length > 0) {
    renderSection("Evidence (highest relevance first)");
    for (const item of bundle.evidence) {
      console.log(`  [${item.score}] ${item.kind} — ${item.title}`);
      const where = item.location ? `${formatLocation(item.location)} — ` : "";
      console.log(`         ${where}${item.reason}`);
    }
  }

  const reads = nextReads(bundle);
  if (reads.length > 0) {
    renderSection("Next");
    for (const cmd of reads) console.log(`  ${cmd}`);
  }

  const trunc = bundle.truncation;
  if (trunc.entitiesTruncated + trunc.relationshipsTruncated + trunc.evidenceTruncated > 0) {
    const advice = truncationAdvice(bundle);
    renderNote(
      `Truncated: ${trunc.entitiesTruncated} entities, ${trunc.relationshipsTruncated} relationships, ${trunc.evidenceTruncated} evidence items.`
      + (advice ? ` ${advice}` : " Raise --max-tokens for more."),
    );
  }
  console.log();
}

/**
 * Evidence sources, as the word a hint can put a number in front of.
 *
 * Keyed on `source` rather than `kind`: `kind` is `structural` for members,
 * imports, calls, callers and dependents alike, and "cut: 48 structural" is the
 * uninformative sentence this exists to replace.
 */
/** Said wherever a bundle's start came from BM25 rather than from the issue's names. */
const ISSUE_FALLBACK_NOTE =
  "Nothing the issue names resolved to a definition; the bundle starts from the file whose text matches the issue best (BM25).";

const CUT_LABELS: Record<string, string> = {
  "issue.starts": "starting points row",
  "issue.ranking": "ranked files row",
  "facts.container": "container",
  "facts.members": "member",
  "facts.imports": "import",
  "facts.callees": "call",
  "facts.neighbours": "neighbouring definition",
  "facts.related": "related file",
  "git.history": "recent commits",
  "facts.callers": "caller",
  "facts.dependents": "dependent",
  "context.claims": "claim",
  "context.decisions": "decision",
  "context.conflicts": "conflict",
  "context.intents": "intent",
  "context.edges": "relationship",
};

/** Group the evidence a budget dropped by category, largest first. */
function summariseCut(dropped: EvidenceItem[]): Array<{ what: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of dropped) {
    const what = CUT_LABELS[item.source] ?? item.kind;
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([what, count]) => ({ what, count }))
    .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what));
}

/**
 * The cheapest command that gets back what the budget dropped.
 *
 * Target-specific because the answer is: a file that lost its own members wants
 * one of those members as a target, not a bigger budget for the file; a symbol
 * that lost callers wants `ix callers`, which is bounded and ranked and costs a
 * fraction of a bundle. `--max-tokens` is named last, as the lever that works
 * for anything and pays for everything.
 */
function cutLever(bundle: ContextBundle, top: { what: string }): string {
  if (forMcp()) return mcpCutLever(bundle, top);
  const name = bundle.target.name;
  const container = CONTAINER_TARGET_KINDS.includes(bundle.target.kind.toLowerCase());
  switch (top.what) {
    case "member":
      return container
        ? `run ix context on one of them, or raise --max-tokens`
        : `ix contains ${name}, or raise --max-tokens`;
    case "caller":
      return `ix callers ${name}, or raise --max-tokens`;
    case "dependent":
      return `ix impact ${name}, or raise --max-tokens`;
    case "import":
      return `ix imports ${name}, or raise --max-tokens`;
    case "call":
      return `ix callees ${name}, or raise --max-tokens`;
    case "relationship":
      return `ix depends ${name}, or raise --max-tokens`;
    case "claim":
    case "conflict":
      return `ix conflicts ${name}, or raise --max-tokens`;
    default:
      return `raise --max-tokens`;
  }
}

const CONTAINER_TARGET_KINDS: readonly string[] = ["file", "module", "class", "object", "trait", "interface"];

/**
 * {@link cutLever} for an MCP caller: only core tools, and `max_tokens` for
 * the budget, since `ix_context` takes no flags. `ix contains`, `ix depends`
 * and `ix conflicts` have no core tool, so those cuts fall back to the nearest
 * one that does exist, or to the budget alone.
 */
function mcpCutLever(bundle: ContextBundle, top: { what: string }): string {
  const { name, path } = bundle.target;
  const container = CONTAINER_TARGET_KINDS.includes(bundle.target.kind.toLowerCase());
  const pin = container ? {} : { path };
  const budget = "raise max_tokens (default 3000)";
  switch (top.what) {
    case "member":
      return container ? `call ix_context on one of them, or ${budget}` : budget;
    case "caller":
      return `${suggest.neighbors(name, "callers", pin)}, or ${budget}`;
    case "dependent":
    case "relationship":
      return `${suggest.impact(name, pin)}, or ${budget}`;
    case "import":
      return `${suggest.neighbors(name, "imports", pin)}, or ${budget}`;
    case "call":
      return `${suggest.neighbors(name, "callees", pin)}, or ${budget}`;
    default:
      return budget;
  }
}

/** One sentence naming what was cut and the cheapest way to get it back. */
export function truncationAdvice(bundle: ContextBundle): string | undefined {
  const cut = bundle.truncation.cut ?? [];
  if (cut.length === 0) return undefined;
  const named = cut
    .slice(0, 3)
    .map((c) => `${c.count} ${c.what}${c.count === 1 ? "" : "s"}`)
    .join(", ");
  return `cut: ${named} — ${cutLever(bundle, cut[0])}`;
}

/** Members placed ahead of the backend's context nodes; the evidence shows as many. */
const LEADING_MEMBERS = 10;

/** Imports named in the evidence. The rest still enter the bundle as entities,
 * where they cost a line each and can carry the answer's file. */
const SHOWN_IMPORTS = 8;

/** Members of neighbouring files named in the evidence; the rest are entities. */
const SHOWN_NEIGHBOUR_MEMBERS = 6;
/** Members shown before anything outside the target; the rest close the list. */
const MEMBERS_BEFORE_OUTWARD = 5;

type Located = { path?: string; lineStart?: number; lineEnd?: number };

/** `path`, `lineStart` and `lineEnd`, omitting the unknown ones rather than writing `undefined`. */
function locationFields(ref: Located): Located {
  return {
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.lineStart !== undefined ? { lineStart: ref.lineStart } : {}),
    ...(ref.lineEnd !== undefined ? { lineEnd: ref.lineEnd } : {}),
  };
}

/** An evidence `location`, or nothing when the path is unknown. */
/** The target's own `path:start-end`, or just its path when it has no range. */
function targetLocation(facts: ContextFacts): Located | undefined {
  if (!facts.path) return undefined;
  return { path: facts.path, lineStart: facts.lineStart, lineEnd: facts.lineEnd };
}

/**
 * The reads worth making next, most valuable first.
 *
 * The evidence rows carry `path:start-end` and the caller still has to decide
 * which of them to open — so the bundle ends by saying so, as commands rather
 * than coordinates. The saving this exists for is the whole-file read: on the
 * benchmark set one avoided 34-61k-character read is worth more than every
 * byte the bundle spends, and an agent handed a path with no range opens the
 * file.
 *
 * Deduped, because a caller and a dependent are frequently the same function,
 * and taken in evidence order, which is already the ranking — the target first,
 * then its members, what it reaches, and what reaches it.
 */
export function nextReads(bundle: ContextBundle, limit = 3): string[] {
  const seen = new Set<string>();
  const reads: string[] = [];
  for (const item of bundle.evidence) {
    const loc = item.location;
    if (!loc?.path || loc.lineStart === undefined || loc.lineEnd === undefined) continue;
    const range = `${loc.path}:${loc.lineStart}-${loc.lineEnd}`;
    if (seen.has(range)) continue;
    seen.add(range);
    reads.push(`ix read ${range}`);
    if (reads.length === limit) break;
  }
  return reads;
}

/** Longest range a suggested read may span; past it the read covers its head only. */
export const NEXT_READ_MAX_LINES = 120;

/**
 * The next calls worth making, for an MCP caller.
 *
 * {@link nextReads} closes a CLI bundle with `ix read path:a-b`, which over MCP
 * is the one suggestion an agent's own Read tool already covers — and the
 * recorded agents that did follow the bundle never once asked the graph the
 * questions only it answers. So the MCP close leads with those: who calls (or
 * imports) the target across files, and what a change to it reaches. A read of
 * the target's own range comes last, capped so a 558-line class does not turn
 * into a 558-line suggestion.
 *
 * Every call names core tools only, and pins the target's file with `path=` so
 * an ambiguous name resolves to the entity this bundle was built for.
 */
export function nextToolCalls(bundle: ContextBundle): Array<{ cmd: string; why: string }> {
  const { name, kind, path } = bundle.target;
  const steps: Array<{ cmd: string; why: string }> = [];
  const isFile = kind.toLowerCase() === "file";
  // A file resolves by its path; a symbol by name, pinned to its file.
  const symbol = isFile ? (path ?? name) : name;
  const pin = isFile ? {} : { path };

  steps.push(
    isFile
      ? { cmd: suggest.neighbors(symbol, "imported_by", pin), why: "every file that imports this one" }
      : { cmd: suggest.neighbors(symbol, "callers", pin), why: "every call site across files, from the graph rather than a name match" },
  );
  steps.push({ cmd: suggest.impact(symbol, pin), why: "what a change here reaches, before you edit it" });

  const read = bundle.evidence.find(
    (item) => item.location?.path && item.location.lineStart !== undefined && item.location.lineEnd !== undefined,
  )?.location;
  if (read?.lineStart !== undefined && read.lineEnd !== undefined) {
    const end = Math.min(read.lineEnd, read.lineStart + NEXT_READ_MAX_LINES - 1);
    steps.push({
      cmd: toolCall("ix_read", { symbol: `${read.path}:${read.lineStart}-${end}` }),
      why: end < read.lineEnd
        ? `first ${NEXT_READ_MAX_LINES} of ${read.lineEnd - read.lineStart + 1} lines of the top-ranked evidence`
        : "the top-ranked evidence",
    });
  }
  return steps;
}

function locationField(ref: Located | undefined): { location?: EvidenceLocation } {
  if (!ref?.path) return {};
  return { location: { ...locationFields(ref), path: ref.path } };
}

function lineRange(location: EvidenceLocation): string | undefined {
  const { lineStart, lineEnd } = location;
  if (lineStart === undefined) return undefined;
  return lineEnd !== undefined && lineEnd !== lineStart ? `${lineStart}-${lineEnd}` : `${lineStart}`;
}

function formatLocation(location: EvidenceLocation): string {
  const lines = lineRange(location);
  return lines ? `${location.path}:${lines}` : location.path;
}

/** `rank.ts via listByKind, resolveWorkspaceId`, or just `rank.ts`. */
function relatedClause(ref: RelatedRef): string {
  const name = (ref.path ?? ref.name).split("/").pop();
  if (ref.named) return `${name} (${ref.named})`;
  return ref.via.length > 0 ? `${name} via ${ref.via.join(", ")}` : `${name} directly`;
}

function memberReason(ref: EntityLocation): string {
  if (ref.usedBy === undefined) return "defined in the target";
  if (ref.usedBy === 0) return "defined in the target; no recorded uses";
  const files = ref.usedFromFiles ?? 0;
  const where = files > 0 ? ` across ${files} other file${files === 1 ? "" : "s"}` : " within this file";
  return `defined in the target; used by ${ref.usedBy}${where}`;
}

/**
 * Names for relationship endpoints. Relationship evidence used to print raw
 * ids -- `264cc04d-... --CONTAINS--> d1898d46-...` -- which an agent cannot use.
 * A name shared by two entities is qualified with its path, since several
 * files are routinely named `config.ts` or `README.md`; an id the bundle knows
 * nothing about stays an id.
 */
function entityLabeller(entities: ContextBundle["entities"]): (id: string) => string {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameCounts = new Map<string, number>();
  for (const e of entities) nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);
  return (id) => {
    const e = byId.get(id);
    if (!e) return id;
    return (nameCounts.get(e.name) ?? 0) > 1 && e.path ? `${e.name} (${e.path})` : e.name;
  };
}

/**
 * The source record of a `/v1/provenance` response.
 *
 * The endpoint answers `{ entityId, chain: [{ rev, source: { uri, extractor,
 * ... } }] }`, and this used to read `sourceUri` and `extractor` off the top
 * level, where they never are -- so every bundle reported "provenance unknown,
 * extractor unknown". The newest chain entry is the one that describes the
 * current node. A flat record is still accepted as-is.
 */
function provenanceSource(provenance: unknown): Record<string, unknown> {
  const record = asRecord(provenance);
  const chain = Array.isArray(record.chain) ? record.chain.map(asRecord) : undefined;
  if (!chain) return record;
  if (chain.length === 0) return {};
  const latest = chain.reduce((a, b) =>
    (typeof b.rev === "number" ? b.rev : -Infinity) > (typeof a.rev === "number" ? a.rev : -Infinity) ? b : a);
  const source = asRecord(latest.source);
  return {
    sourceUri: source.uri ?? source.sourceUri,
    sourceHash: source.sourceHash,
    extractor: source.extractor,
    sourceType: source.sourceType,
    observedAt: latest.observedAt ?? source.observedAt,
  };
}

function orderedNodes<T extends { id: string; kind: string; name: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.id, b.id));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
