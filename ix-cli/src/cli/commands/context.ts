import { InvalidArgumentError, type Command } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  BUNDLE_SCHEMA,
  contextBundleSchema,
  savedInvestigationSchema,
} from "../context-bundle-schema.js";

import { IxClient } from "../../client/api.js";
import type {
  ConflictReport,
  DecisionReport,
  IntentReport,
  StructuredContext,
} from "../../client/types.js";
import { getEndpoint } from "../config.js";
import { collectFacts, type EntityFacts } from "../explain/facts.js";
import { llmLine, printLlmLines } from "../llm.js";
import { parseBudgetOption, parsePickOption, parseRevisionOption } from "../options.js";
import { resolveFileOrEntity } from "../resolve.js";
import { createStaleProbe } from "../stale.js";
import { renderNote, renderSection, renderWarning, renderWarningErr, reportFailure } from "../ui.js";

/** The four `--max-*` knobs that bound a bundle. */
interface BudgetSnapshot {
  maxEntities: number;
  maxRelationships: number;
  maxEvidence: number;
  maxChars: number;
}

/**
 * The four budgets, described once: flag key, output label, clamp range, and
 * the default applied when the flag is absent.
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
const BUDGETS = [
  { key: "maxEntities", flag: "--max-entities", label: "entities", help: "Maximum entities in the bundle", min: 1, max: 500, fallback: 50 },
  { key: "maxRelationships", flag: "--max-relationships", label: "relationships", help: "Maximum relationships in the bundle", min: 1, max: 1000, fallback: 100 },
  { key: "maxEvidence", flag: "--max-evidence", label: "evidence", help: "Maximum evidence items in the bundle", min: 1, max: 200, fallback: 25 },
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

/** Apply the table's range and default to whatever the caller supplied. */
function clampBudgets(opts: Partial<BudgetSnapshot>): BudgetSnapshot {
  const out = {} as BudgetSnapshot;
  for (const b of BUDGETS) {
    const raw = opts[b.key];
    out[b.key] = raw === undefined ? b.fallback : Math.min(b.max, Math.max(b.min, raw));
  }
  return out;
}

interface ContextOptions extends Partial<BudgetSnapshot> {
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

function parseContextDepthOption(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!(CONTEXT_DEPTHS as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(`must be one of: ${CONTEXT_DEPTHS.join(", ")}`);
  }
  return normalized;
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

interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: string;
  title: string;
  /** Deterministic relevance score: tier plus a stable tiebreaker. */
  score: number;
  reason: string;
  refs: string[];
}

interface ContextBundle {
  schema: typeof BUNDLE_SCHEMA;
  /** The one explicitly declared time-dependent field. */
  generatedAt: string;
  target: { id: string; name: string; kind: string; resolutionMode: string };
  entities: Array<{ id: string; name: string; kind: string; path?: string; stale: boolean }>;
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
  freshness: { stale: boolean; classification: "current" | "stale" | "unverified" };
  evidence: EvidenceItem[];
  budgets: BudgetSnapshot;
  truncation: {
    entitiesTruncated: number;
    relationshipsTruncated: number;
    evidenceTruncated: number;
    charactersTruncated: number;
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
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
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
    .option("--max-chars <n>", budgetHelp("maxChars"), budgetParser("maxChars"))
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--out <path>", "Write the JSON bundle to this file instead of stdout")
    .option("--save <id>", "Persist the bundle as a resumable investigation state")
    .option("--resume <id>", "Render a saved investigation state without a backend")
    .option("--diff <id>", "Diff a saved investigation against a fresh build of the same target")
    .option("--list", "List saved investigations (no target, no backend)")
    .addHelpText(
      "after",
      "\nExamples:\n  ix context IngestionService\n  ix context src/main.ts --format json\n  ix context Widget --max-entities 20 --max-evidence 10\n  ix context Widget --save widget-investigation\n  ix context --resume widget-investigation\n  ix context --diff widget-investigation\n  ix context --list",
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
        );
        if (!fresh) return;
        renderInvestigationDiff(saved, fresh, opts.format, requestedBudgets);
        return;
      }
      if (!target) {
        // An error with a non-zero status, not a stdout warning with a zero one:
        // a script asked for a bundle and got none, and a `--format llm` caller
        // got a prose line in the middle of a record stream saying so.
        reportFailure(
          "missing_target",
          "ix context requires a target unless --resume <id>, --diff <id> or --list is given.",
          opts.format,
        );
        return;
      }

      const client = new IxClient(getEndpoint());

      const resolved = await resolveFileOrEntity(client, target, {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick,
      });
      if (!resolved) return;

      const budgets = clampBudgets(opts);
      const asOfRev = opts.asOfRev;

      const [facts, context, provenance] = await Promise.all([
        collectFacts(client, resolved.id, resolved.name, resolved.kind),
        client.query(resolved.name, {
          asOfRev,
          depth: opts.depth,
        }),
        client.provenance(resolved.id),
      ]);

      const bundle = buildBundle({
        resolved,
        facts,
        context,
        provenance,
        asOfRev,
        depth: opts.depth,
        budgets,
      });

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
    });

async function buildFreshBundle(
  target: string,
  opts: { kind?: string; path?: string; pick?: number; depth?: string; asOfRev?: number },
  budgets: BudgetSnapshot,
): Promise<ContextBundle | undefined> {
  const client = new IxClient(getEndpoint());
  const resolved = await resolveFileOrEntity(client, target, {
    kind: opts.kind,
    path: opts.path,
    pick: opts.pick,
  });
  if (!resolved) return undefined;

  const asOfRev = opts.asOfRev;
  const [facts, context, provenance] = await Promise.all([
    collectFacts(client, resolved.id, resolved.name, resolved.kind),
    client.query(resolved.name, { asOfRev, depth: opts.depth }),
    client.provenance(resolved.id),
  ]);

  return buildBundle({ resolved, facts, context, provenance, asOfRev, depth: opts.depth, budgets });
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
  if (opts.list && target) {
    return `--list takes no target; it enumerates every saved investigation. Drop "${target}", or drop --list to build a fresh bundle for it.`;
  }
  if (opts.resume && target) {
    return `--resume takes no target; it renders the investigation you name, whatever that was built for. Drop "${target}", or use --diff <id> to compare a saved investigation against a fresh build of it.`;
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
 * including the escape marker `~` itself — is hex-encoded as `~HH`. Two
 * different logical ids can therefore never map to the same file, and a raw
 * `~` in user input cannot be confused with an encoding: `a/b`, `a?b`, and
 * `a~2Fb` all land in distinct, single-segment files under the investigation
 * directory instead of silently colliding or escaping it.
 *
 * A leading `.` is encoded too, so no id can produce a dotfile. `.` is otherwise
 * an ordinary character here, and encoding it only in first position keeps the
 * mapping injective: `.a` becomes `~2Ea`, which no other id can also produce.
 */
export function sanitizeId(id: string): string {
  let out = "";
  for (const ch of id) {
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
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
 * The escape is not fixed-width, and that is why this decodes and then
 * re-encodes rather than trusting the decode. `toString(16)` gives two hex
 * digits below U+0100 and three or four above it, so `~7528` is either one CJK
 * code unit or `~752` followed by a literal `8`, and nothing in the string says
 * which. Two hex digits is the case every Latin-1 id takes; anything else fails
 * the re-encode and the stored id is returned untouched, which is honest rather
 * than a guess. `loadInvestigation` accepts that form too, so a listed id loads
 * either way — the display is the nicety, the load is the contract.
 */
export function displayId(stored: string): string {
  const decoded = stored.replace(/~([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
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
    console.log(JSON.stringify({ investigations: summaries, skipped }, null, 2));
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
    console.log(JSON.stringify(saved, null, 2));
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
      id: e.id,
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
    llmLine("evidence", { change, score: e.score, kind: e.kind, title: e.title });
}

function claimRecord(change: RecordChange) {
  return (c: ContextBundle["claims"][number]): string =>
    llmLine("claim", {
      change,
      id: c.id,
      entity: c.entityId,
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
    console.log(JSON.stringify(diff, null, 2));
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
      ...diff.added.relationships.map((r) => llmLine("relationship", { change: "added", src: r.src, pred: r.predicate, dst: r.dst })),
      ...diff.removed.relationships.map((r) => llmLine("relationship", { change: "removed", src: r.src, pred: r.predicate, dst: r.dst })),
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
  facts: EntityFacts;
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
}

export function buildBundle(input: BuildInput): ContextBundle {
  const { resolved, facts, context, provenance, asOfRev, depth, budgets } = input;

  const stale = facts.stale;
  const classification = stale ? "stale" : "current";
  const prov = asRecord(provenance);

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
      path: facts.path,
      stale,
    },
  ];
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
        path: node.sourceUri ?? undefined,
      }));
  for (const node of orderedNodes(contextNodes)) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    entities.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      path: node.path,
      stale: false, // replaced below, for the entities that survive the budget
    });
  }

  // Relationships: graph edges, ordered deterministically.
  const contextEdges = context.edges.length > 0 ? context.edges : (context.edgeSummaries ?? []);
  const relationships = [...contextEdges]
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.predicate, b.predicate))
    .map((edge) => ({ src: edge.src, dst: edge.dst, predicate: edge.predicate }));

  const evidence = rankEvidence({ resolved, facts, context, relationships, prov });

  const bundle: ContextBundle = {
    schema: BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    target: {
      id: resolved.id,
      name: resolved.name,
      kind: resolved.kind,
      resolutionMode: resolved.resolutionMode,
    },
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
    evidence: [],
    budgets,
    truncation: {
      entitiesTruncated: 0,
      relationshipsTruncated: 0,
      evidenceTruncated: 0,
      charactersTruncated: 0,
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

  const relLimit = Math.min(relationships.length, budgets.maxRelationships);
  bundle.relationships = relationships.slice(0, relLimit);
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
  const fullChars = sizedEvidence.reduce((sum, entry) => sum + entry.size, 0);
  bundle.truncation.charactersTruncated = Math.max(0, fullChars - chars);

  return bundle;
}

/** Deterministic evidence ranking: tier, then a stable id tiebreaker. */
function rankEvidence(input: {
  resolved: { id: string; name: string; kind: string };
  facts: EntityFacts;
  context: StructuredContext;
  relationships: Array<{ src: string; dst: string; predicate: string }>;
  prov: Record<string, unknown>;
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
  });

  const structural: Array<{ id: string; source: string; title: string; refs: string[] }> = [];
  if (input.facts.container) {
    structural.push({
      id: `container:${input.facts.container.name}`,
      source: "facts.container",
      title: `container ${input.facts.container.name} (${input.facts.container.kind})`,
      refs: [],
    });
  }
  for (const name of input.facts.topCallers) {
    structural.push({ id: `caller:${name}`, source: "facts.callers", title: `caller ${name}`, refs: [] });
  }
  for (const name of input.facts.topDependents) {
    structural.push({
      id: `dependent:${name}`,
      source: "facts.dependents",
      title: `dependent ${name}`,
      refs: [],
    });
  }
  for (const name of input.facts.members.slice(0, 10)) {
    structural.push({ id: `member:${name}`, source: "facts.members", title: `member ${name}`, refs: [] });
  }
  structural.forEach((item, index) => {
    items.push({ ...item, kind: "structural", score: 10 + index, reason: "direct structural relationship" });
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
  for (const conflict of input.context.conflicts) {
    items.push({
      id: `conflict:${conflict.id}`,
      kind: "conflict",
      source: "context.conflicts",
      title: `${conflict.claimA} vs ${conflict.claimB}`,
      score: 22,
      reason: conflict.reason,
      refs: [],
    });
  }
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

  input.relationships.slice(0, 50).forEach((edge, index) => {
    items.push({
      id: `relationship:${edge.src}:${edge.dst}:${edge.predicate}`,
      kind: "relationship",
      source: "context.edges",
      title: `${edge.src} --${edge.predicate}--> ${edge.dst}`,
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

export function renderBundle(bundle: ContextBundle, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(bundle, null, 2));
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
        stale: bundle.freshness.stale,
        classification: bundle.freshness.classification,
        entities: bundle.entities.length,
        relationships: bundle.relationships.length,
        claims: bundle.claims.length,
        decisions: bundle.decisions.length,
        conflicts: bundle.conflicts.length,
        intents: bundle.intents.length,
        evidence: bundle.evidence.length,
        truncated_entities: bundle.truncation.entitiesTruncated,
        truncated_relationships: bundle.truncation.relationshipsTruncated,
        truncated_evidence: bundle.truncation.evidenceTruncated,
        truncated_chars: bundle.truncation.charactersTruncated,
      }),
      // Evidence only, as before. The entity, relationship and claim lists are
      // deliberately still counts here: `--format llm` is the token-minimal
      // surface, the ranked evidence is what it exists to deliver, and
      // `--format json` carries the rest for a caller that wants it.
      ...bundle.evidence.map(evidenceRecord(undefined)),
    ]);
    return;
  }

  renderSection(`Context: ${bundle.target.name}`);
  console.log(`  kind:          ${bundle.target.kind}`);
  console.log(`  classification:${bundle.freshness.classification}`);
  console.log(`  entities:      ${bundle.entities.length}`);
  console.log(`  relationships: ${bundle.relationships.length}`);
  console.log(`  claims:        ${bundle.claims.length}`);
  console.log(`  decisions:     ${bundle.decisions.length}`);
  console.log(`  conflicts:     ${bundle.conflicts.length}`);
  console.log(`  intents:       ${bundle.intents.length}`);
  if (bundle.freshness.stale) {
    renderWarning("Source has changed since last ingest. Run ix map to update.");
  }

  if (bundle.evidence.length > 0) {
    renderSection("Evidence (highest relevance first)");
    for (const item of bundle.evidence) {
      console.log(`  [${item.score}] ${item.kind} — ${item.title}`);
      console.log(`         ${item.reason}`);
    }
  }

  const trunc = bundle.truncation;
  if (trunc.entitiesTruncated + trunc.relationshipsTruncated + trunc.evidenceTruncated > 0) {
    renderNote(
      `Truncated: ${trunc.entitiesTruncated} entities, ${trunc.relationshipsTruncated} relationships, ${trunc.evidenceTruncated} evidence items. Rerun with larger --max-* budgets for more.`,
    );
  }
  console.log();
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
