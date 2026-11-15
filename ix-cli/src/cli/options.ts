// Copyright 2026 Ix Infrastructure Inc.

import { InvalidArgumentError, Option, type Command } from "commander";
import { DEFAULT_FORMAT_CHOICES } from "./default-format.js";
import { OFFSET_FLAG, parseOffset } from "./paging.js";

/**
 * Parse a flag that must be a positive integer, rejecting anything else.
 *
 * The regex is the check; `Number` is only the conversion. `Number.parseInt`
 * on its own is not a validator and never was: it reads `"10abc"` as 10,
 * `"0x10"` as 0, `"1e3"` as 1 and `"-5"` as -5, so every one of those reaches
 * the command as a value the caller never typed. `Number.isSafeInteger` then
 * rejects the digit strings too large to survive the round trip.
 *
 * `example` is interpolated into the message so each flag can show a plausible
 * value for itself; the wording is otherwise identical, because the rule is.
 */
function parsePositiveInt(value: string, example: string): number {
  const normalized = value.trim();
  const reject = () =>
    new InvalidArgumentError(`must be a positive integer (for example, ${example})`);
  if (!/^\+?[1-9]\d*$/.test(normalized)) throw reject();

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw reject();
  return parsed;
}

function parseNonNegativeInt(value: string, example: string): number {
  const normalized = value.trim();
  const reject = () =>
    new InvalidArgumentError(`must be a non-negative integer (for example, ${example})`);
  if (!/^\+?\d+$/.test(normalized)) throw reject();

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw reject();
  return parsed;
}

function invalidOption(option: Option, detail: string): InvalidArgumentError {
  return new InvalidArgumentError(`option '${option.long}' ${detail}`);
}

/**
 * Validate common option domains before a command can contact the backend.
 *
 * Most commands read numeric options with `parseInt` and route any unrecognized
 * output format through their text branch. That turns typos into a different,
 * successful request. Keeping this at the root command covers OSS and optional
 * Pro commands consistently, including the long-lived MCP runner.
 */
export function validateCliOptions(command: Command): void {
  const values = command.opts();

  for (const option of command.options) {
    const name = option.attributeName();
    // Only what the caller actually typed. A default is the command author's
    // own choice, and checking it turns a mismatch into a command nobody can
    // run: `ix smells` defaults `--orphan-max-connections` to 0, which the
    // `<n>` rule below rejected, so the command failed before its action ever
    // started -- on no arguments at all. Anything the author ships as a
    // default is by definition a value the command accepts.
    if (command.getOptionValueSource(name) !== "cli") continue;
    const value = values[name];
    if (value === undefined || value === null) continue;

    if (typeof value === "string") {
      if (option.long === "--as-of") {
        try { parseRevisionOption(value); }
        catch { throw invalidOption(option, "must be a positive integer"); }
      }

      if (option.long === "--min-confidence") {
        const parsed = Number(value);
        if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value.trim()) || parsed < 0 || parsed > 1) {
          throw invalidOption(option, "must be a number from 0 to 1");
        }
      } else if (option.flags.includes("<n>")) {
        // Non-negative, not positive. 0 is a documented value for several of
        // these -- `--offset 0`, `--orphan-max-connections 0` (its own
        // default), `--weak-max-neighbors 0` -- and none of the typos this
        // exists to catch survive either rule: `1e3`, `10abc`, `0x10`, `-5`
        // and `abc` are all rejected. The flags that genuinely mean "at least
        // one" declare `parsePositiveInt` as their own commander parser
        // (`--pick`), so commander still rejects 0 for them at parse time.
        try { parseNonNegativeInt(value, "0 or 10"); }
        catch { throw invalidOption(option, "must be a non-negative integer"); }
      }
    }
  }
}

/**
 * Parse a count flag read inside a command's action, such as `ix trace
 * --depth`/`--cap`: a non-negative integer.
 *
 * The root `validateCliOptions` hook already refuses a malformed `<n>` value
 * before the action runs; this is the same rule at the point of use, so a
 * command registered without that hook (the test harnesses) still cannot turn
 * `abc` into NaN the way `parseInt` did. It is not a commander option parser
 * on purpose: that path prints commander's plain error, not the formatted
 * `cli_error` record.
 */
export function parseCountOption(value: string, example: string): number {
  return parseNonNegativeInt(value, example);
}

export function parsePickOption(value: string): number {
  return parsePositiveInt(value, "1 or 2");
}

/**
 * `--strict` on every command that resolves a target through the shared path
 * (resolve.ts `answerAmbiguous`, text-matches.ts). One string, so the help and
 * skills/ix/references/flags.md say the same thing everywhere.
 */
export const STRICT_TARGET_HELP =
  "Report an ambiguous target (exit 2) or a name found only as text (exit 3) as an error instead of answering it";

/** `--strict` on a command that never answers with text matches (`diff`, `history`): only the ambiguity changes. */
export const STRICT_AMBIGUOUS_HELP =
  "Report an ambiguous target as an error (exit 2) instead of answering it for the top candidate";

/**
 * The longest `--wait <seconds>` budget: 5 minutes. Node's fetch (undici)
 * gives up on a response whose headers have not arrived after 300 s whatever
 * the request's own timeout, so a longer wait would end there anyway.
 */
export const MAX_WAIT_SECONDS = 300;

/**
 * Parse a `--wait <seconds>` budget: a positive whole number of seconds, at
 * most `MAX_WAIT_SECONDS`.
 */
export function parseWaitSecondsOption(value: string): number {
  const seconds = parsePositiveInt(value, "20 or 300");
  if (seconds > MAX_WAIT_SECONDS) {
    throw new InvalidArgumentError(
      `must be at most ${MAX_WAIT_SECONDS} seconds, the longest the HTTP client waits for an answer (for example, 20 or 300)`,
    );
  }
  return seconds;
}

/**
 * Parse a `--max-*` budget flag.
 *
 * Validated at parse time rather than read back out of the raw option string
 * later, so the value is parsed once and a malformed one is refused where the
 * user can see which flag they mistyped. `ix context --diff` reports the
 * requested budget back to the caller, and a silently repaired number
 * (`--max-entities 1e3` becoming 1) is a misreport of the one thing that record
 * exists to carry.
 *
 * `example` is the flag's own default, supplied by the caller. A shared literal
 * would be wrong for at least one flag: `--max-chars` starts at 12000 and
 * clamps up from anything below 1000, so suggesting 50 there names a value the
 * command silently replaces.
 */
export function parseBudgetOption(value: string, example: string): number {
  return parsePositiveInt(value, example);
}

/**
 * Parse a revision flag: a positive integer graph revision.
 *
 * `parseInt(opts.asOfRev, 10)` reached `client.query({ asOfRev })` and
 * `buildBundle` unchecked, so `--as-of-rev abc` sent NaN to the backend,
 * `--as-of-rev 3.9` silently became 3, and `--as-of-rev 10abc` became 10 — the
 * same not-a-validator failure the budget flags had, on the flag two lines
 * above them.
 */
export function parseRevisionOption(value: string): number {
  return parsePositiveInt(value, "12");
}

/*
 * The options most commands share, declared once.
 *
 * Each factory returns a fresh commander `Option`, so a command chain keeps its
 * own declaration order with `.addOption(kindOption())`; the `add*Options`
 * helpers below declare a whole group where a command takes the group as is.
 * The help text, default and parser live here and nowhere else: a copy in a
 * command file is how the same flag came to behave differently between two
 * commands. A command whose flag genuinely means something else (`ix rank
 * --kind`, `ix watch --path`) keeps its own declaration and its own words.
 */

/** `--kind` on a command that resolves one target. */
export function kindOption(): Option {
  return new Option("--kind <kind>", "Filter target entity by kind");
}

/** `--path` on a command that resolves one target. */
export function pathOption(): Option {
  return new Option("--path <path>", "Restrict to symbols from files matching this path substring");
}

/** `--no-suggest` on a command that offers did-you-mean candidates for an unresolved target. */
export function noSuggestOption(): Option {
  return new Option("--no-suggest", "Disable did-you-mean candidates on unresolved targets");
}

/** `--pick`: a 1-based candidate number, validated by commander at parse time. */
export function pickOption(): Option {
  return new Option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)").argParser(parsePickOption);
}

/**
 * `--strict`. `help` is `STRICT_AMBIGUOUS_HELP` on a command that never
 * answers with text matches.
 */
export function strictOption(help: string = STRICT_TARGET_HELP): Option {
  return new Option("--strict", help);
}

/** `--limit` on a paged edge or row list. The default stays a string, as typed values are. */
export function pageLimitOption(defaultLimit = "50"): Option {
  return new Option("--limit <n>", "Max results to show").default(defaultLimit);
}

/** `--offset` on a paged list; `nextPageCommand` (paging.ts) writes the next page's value. */
export function pageOffsetOption(): Option {
  return new Option("--offset <n>", OFFSET_FLAG).default("0");
}

/**
 * `--format`, its allowed values declared with it. The help names the same
 * values the choices accept, so the two cannot disagree. The default is the
 * built-in `text`, which `applyOssSetup` moves to a configured default where
 * the command accepts it.
 */
export function formatOption(formats: readonly string[] = DEFAULT_FORMAT_CHOICES): Option {
  return new Option("--format <fmt>", `Output format (${formats.join("|")})`)
    .choices([...formats])
    .default("text");
}

/** The values each `choiceOption` accepts, for `applyOssSetup` to enforce. */
const SETUP_CHOICES = new WeakMap<Option, readonly string[]>();

/**
 * An option that accepts only `values`, declared on the command that owns it.
 *
 * The values are enforced by `applyOssSetup` (`register/oss-setup.ts`), on
 * every OSS command it sets up -- the full registration and the startup fast
 * path alike -- not by this declaration. That is where they were enforced
 * when they lived in one table keyed by command name, and commander's
 * `.choices()` replaces any parser the option declares: `ix context --depth`
 * has its own, which a command registered on its own still runs.
 */
export function choiceOption(
  flags: string,
  description: string,
  values: readonly string[],
  defaultValue?: string,
): Option {
  const option = new Option(flags, description);
  if (defaultValue !== undefined) option.default(defaultValue);
  SETUP_CHOICES.set(option, values);
  return option;
}

/** What `choiceOption` declared for `option`, if it came from there. */
export function declaredChoices(option: Option): readonly string[] | undefined {
  return SETUP_CHOICES.get(option);
}

/** What `addTargetOptions` declares, as the action receives it. */
export interface TargetOptionValues {
  kind?: string;
  path?: string;
  pick?: number;
  strict?: boolean;
}

/**
 * `--kind`, `--path`, `--pick`, `--strict`, in that order. `suggest` adds
 * `--no-suggest` between `--path` and `--pick`, where the commands that offer
 * candidates have always listed it.
 */
export function addTargetOptions(cmd: Command, opts: { suggest?: boolean; strictHelp?: string } = {}): Command {
  cmd.addOption(kindOption()).addOption(pathOption());
  if (opts.suggest) cmd.addOption(noSuggestOption());
  return cmd.addOption(pickOption()).addOption(strictOption(opts.strictHelp));
}

/** The target options out of a command's parsed options, typed, and nothing else. */
export function targetOptionValues(opts: TargetOptionValues): TargetOptionValues {
  return { kind: opts.kind, path: opts.path, pick: opts.pick, strict: opts.strict };
}

/** What `addPagingOptions` declares, as the action receives it: the raw strings commander stores. */
export interface PagingOptionValues {
  limit: string;
  offset: string;
}

/** `--limit` (default `defaultLimit`) and `--offset` (default 0). */
export function addPagingOptions(cmd: Command, defaultLimit = "50"): Command {
  return cmd.addOption(pageLimitOption(defaultLimit)).addOption(pageOffsetOption());
}

/**
 * `--limit` and `--offset` as numbers. The root option validator has already
 * refused a typed value that is not a non-negative integer.
 */
export function pagingValues(opts: PagingOptionValues): { limit: number; offset: number } {
  return { limit: parseInt(opts.limit, 10), offset: parseOffset(opts.offset) };
}

/** `--format` with `formats` as its allowed values (see `formatOption`). */
export function addFormatOption(cmd: Command, formats: readonly string[] = DEFAULT_FORMAT_CHOICES): Command {
  return cmd.addOption(formatOption(formats));
}
