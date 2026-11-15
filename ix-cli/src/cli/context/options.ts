// Copyright 2026 Ix Infrastructure Inc.

// `ix context` flags: the --max-* budgets and their clamping, --depth, the
// bundle's sizing format, and the rules for flags that conflict with a mode.

import { parseBudgetOption } from "../options.js";
import { renderWarningErr } from "../ui.js";

/** The `--max-*` knobs that bound a bundle. */
export interface BudgetSnapshot {
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
const BUDGETS = [
  { key: "maxEntities", flag: "--max-entities", label: "entities", help: "Maximum entities in the bundle", min: 1, max: 500, fallback: 50 },
  { key: "maxRelationships", flag: "--max-relationships", label: "relationships", help: "Maximum relationships in the bundle", min: 1, max: 1000, fallback: 100 },
  { key: "maxEvidence", flag: "--max-evidence", label: "evidence", help: "Maximum evidence items in the bundle", min: 1, max: 200, fallback: 25 },
  { key: "maxTokens", flag: "--max-tokens", label: "tokens", help: "Token budget for the printed output (llm: all of it; json and text: the evidence)", min: 500, max: 200_000, fallback: 3_000 },
  { key: "maxChars", flag: "--max-chars", label: "chars", help: "Character budget for the printed output (llm: all of it; json and text: the evidence)", min: 1000, max: 1_000_000, fallback: 12_000 },
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
export function budgetHelp(key: keyof BudgetSnapshot): string {
  const b = budgetField(key);
  return `${b.help} (default: ${b.fallback}, clamped to ${b.min}-${b.max})`;
}

/** The table row for one budget. */
export function budgetField(key: keyof BudgetSnapshot): (typeof BUDGETS)[number] {
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
export function budgetParser(key: keyof BudgetSnapshot): (value: string) => number {
  const example = String(budgetField(key).fallback);
  return (value: string) => parseBudgetOption(value, example);
}

/** The text a bundle is printed as: `--format llm`, `--format json`, or the prose fallthrough. */
export type BundleFormat = "llm" | "json" | "text";

/** Maps a `--format` value the way `renderBundle` does: anything but json and llm is prose. */
export function bundleFormat(fmt: string | undefined): BundleFormat {
  return fmt === "json" ? "json" : fmt === "llm" ? "llm" : "text";
}

/**
 * Characters per token, by the format the bundle is printed in.
 *
 * `--max-tokens` is charged against the text that is actually emitted, so the
 * ratio is per format. Every format still uses 2.14, the value measured across
 * 41 recorded bundles (JSON plus prompt) and the one saved investigations were
 * sized at, so the default budget is the 6,420 characters it has always been.
 * cl100k measured llm 3.73 and json 2.69 on the audit fixture, so 2.14 is
 * conservative for both: a bundle comes in under its token budget, never over.
 *
 * Raising a ratio makes every default bundle larger (the ix-bench result that
 * all expected files appear at 3,000 tokens was measured at 2.14), so it waits
 * until that is re-measured. Never raise one to make a bundle fit.
 */
export const CHARS_PER_TOKEN: Record<BundleFormat, number> = { llm: 2.14, json: 2.14, text: 2.14 };

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
export function clampBudgets(opts: Partial<BudgetSnapshot>, format: BundleFormat = "json"): BudgetSnapshot {
  const out = {} as BudgetSnapshot;
  for (const b of BUDGETS) {
    const raw = opts[b.key];
    out[b.key] = raw === undefined ? b.fallback : Math.min(b.max, Math.max(b.min, raw));
  }
  if (opts.maxChars === undefined) {
    const chars = budgetField("maxChars");
    out.maxChars = Math.min(
      chars.max,
      Math.max(chars.min, Math.round(out.maxTokens * CHARS_PER_TOKEN[format])),
    );
  }
  return out;
}

export interface ContextOptions extends Partial<BudgetSnapshot> {
  /** An issue or bug report to start from, in place of a target: a file, or `-` for stdin. */
  fromIssue?: string;
  /** With `--from-issue`: only the trusted starting points and a few ranked files. */
  lean?: boolean;
  kind?: string;
  path?: string;
  pick?: number;
  /** `--strict`: an ambiguous or text-only target is an error, not answered. */
  strict?: boolean;
  depth?: string;
  asOfRev?: number;
  out?: string;
  save?: string;
  resume?: string;
  diff?: string;
  list?: boolean;
  format: string;
}

export const CONTEXT_DEPTHS = ["compact", "standard", "full", "shallow", "deep"] as const;

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
  ["strict", "--strict"],
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

/**
 * A budget snapshot as llm record fields.
 *
 * Absent values are simply absent — `llmField` drops nullish, so a partial
 * override needs no `not-given` sentinel the way the prose form does.
 */
export function budgetFields(b: Partial<BudgetSnapshot>): Record<string, number | undefined> {
  return Object.fromEntries(BUDGETS.map((f) => [f.label, b[f.key]]));
}

/** Compact one-line representation of a budget snapshot for human rendering. */
export function formatBudgets(b: Partial<BudgetSnapshot>, partial = false): string {
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
