// Copyright 2026 Ix Infrastructure Inc.

/**
 * What `registerOssCommands()` does to the commands once they are registered:
 * option choices, the configured default `--format`, the shared
 * `--pretty`/`--quiet`/`--fields` options, and the `preAction` hook that
 * applies them and validates option values.
 *
 * Its own module so the CLI's fast path (`register/oss-table.ts`), which
 * registers only the command being run, applies exactly the same setup
 * without loading every other command module to get at it.
 */

import type { Command } from "commander";
import { validateCliOptions } from "../options.js";
import { setPrettyJson } from "../format.js";
import { setOutputShape } from "../output-shape.js";
import {
  BUILT_IN_DEFAULT_FORMAT,
  DEFAULT_FORMAT_CHOICES,
  resolveDefaultFormat,
} from "../default-format.js";
import { readConfiguredFormat } from "../config.js";
import { stderrDim } from "../stderr.js";

const OPTION_CHOICES: Record<string, Record<string, string[]>> = {
  query: { depth: ["shallow", "standard", "deep"], format: ["text", "json"] },
  map: { format: [...DEFAULT_FORMAT_CHOICES, "silent"], sort: ["importance", "confidence", "size", "alpha"] },
  subsystems: { sort: ["importance", "confidence", "size", "alpha"] },
  savings: { model: ["opus", "sonnet", "haiku", "gpt-4o"] },
  context: { depth: ["compact", "standard", "full", "shallow", "deep"] },
  mcp: { tools: ["core", "all"] },
};

/**
 * Every command this file registered, so the preAction hook below can tell an
 * OSS option from a Pro one. Pro commands are registered later, against the
 * same root program, from a package this repo cannot see -- so their option
 * domains are not ours to infer.
 */
const ossCommands = new WeakSet<Command>();

function configureOssOptions(root: Command): void {
  const { format: defaultFormat, ignored } = resolveDefaultFormat(
    process.env,
    // Never let an unreadable or half-written config.yaml stop the CLI from
    // registering its commands: a config that does not parse is reported by the
    // command that needs it (ConfigParseError), not here. And no full parse for
    // one scalar on every invocation, `--version` included.
    () => { try { return readConfiguredFormat(); } catch { return undefined; } },
  );

  // Only where a person will read it: an agent captures stderr, and one more
  // line at the top of its tool result is exactly what this change is for.
  if (ignored && process.stderr.isTTY) {
    stderrDim(
      `Ignoring ${ignored.source}=${ignored.value}: not one of ` +
      `${DEFAULT_FORMAT_CHOICES.join(", ")}. Using ${defaultFormat}.`
    );
  }

  const visit = (command: Command): void => {
    ossCommands.add(command);
    const commandChoices = OPTION_CHOICES[command.name()] ?? {};
    let rendersRows = false;
    let rendersJson = false;
    for (const option of command.options) {
      const choices = commandChoices[option.attributeName()]
        ?? (option.long === "--format" ? [...DEFAULT_FORMAT_CHOICES] : undefined);
      if (choices) option.choices(choices);
      applyDefaultFormat(command, option, choices, defaultFormat);
      if (option.long === "--format") rendersRows = true;
      if (option.long === "--format" && (choices ?? []).includes("json")) rendersJson = true;
    }
    // Declared here rather than 32 times by hand, and only where it means
    // something: a command with no `--format json` has no JSON to shape.
    if (rendersJson && !command.options.some((option) => option.long === "--pretty")) {
      command.option("--pretty", "Indent JSON output (the default only when stdout is a terminal)");
    }
    // Declared here rather than on 33 commands by hand, and only where there
    // is an answer to shape. A command with no `--format` prints a status
    // line or nothing.
    if (rendersRows) {
      if (!command.options.some((option) => option.long === "--quiet")) {
        command.option("--quiet", "Drop headers, section titles and advisory hints");
      }
      if (!command.options.some((option) => option.long === "--fields")) {
        command.option("--fields <list>", "Keep only these fields on each row, in this order (e.g. name,path,lines)");
      }
    }
    for (const child of command.commands) visit(child);
  };
  visit(root);
}

/**
 * Point a `--format` option at the configured default.
 *
 * Only an option still sitting on the built-in `text` is moved: a command that
 * declares a different default has a reason for it, and `ix config set format`
 * is not an instruction to override it. The default must also be a format that
 * command accepts — `query` renders text and json only, so `IX_FORMAT=llm`
 * leaves it where it is rather than handing the renderer a format it has no
 * branch for.
 */
function applyDefaultFormat(
  command: Command,
  option: Command["options"][number],
  choices: string[] | undefined,
  defaultFormat: string,
): void {
  if (option.long !== "--format") return;
  if (defaultFormat === BUILT_IN_DEFAULT_FORMAT) return;
  if (option.defaultValue !== BUILT_IN_DEFAULT_FORMAT) return;
  if (!choices?.includes(defaultFormat)) return;

  option.default(defaultFormat);
  // `.option()` copies the default into the command's option values as it
  // registers, so moving the Option's default afterwards changes the help text
  // and nothing else. The stored value has to be moved with it -- and only
  // while it is still the default, which at registration time it always is.
  if (command.getOptionValueSource(option.attributeName()) === "default") {
    command.setOptionValueWithSource(option.attributeName(), defaultFormat, "default");
  }
}

/**
 * Configure every command registered on `program` so far as an OSS command and
 * install the `preAction` hook. Call once, after the OSS commands are
 * registered and before Pro's are.
 */
export function applyOssSetup(program: Command): void {
  configureOssOptions(program);

  program.hook("preAction", (_thisCommand, actionCommand) => {
    // Before anything prints. All three are properties of the run, not of a
    // payload, so the renderers read them from one place rather than every
    // signature growing parameters it only forwards.
    const opts = actionCommand.opts();
    setPrettyJson(opts.pretty === true);
    setOutputShape({ quiet: opts.quiet === true, fields: typeof opts.fields === "string" ? opts.fields : undefined });

    // OSS commands only. The rules below read an option's *shape* -- `<n>`
    // means a non-negative integer, `--min-confidence` means 0..1 -- which is
    // a claim about commands whose declarations live in this repo. A Pro
    // command declaring `--threshold <n>` for a float would be rejected by a
    // rule its author never opted into, and no test here could catch it.
    if (!ossCommands.has(actionCommand)) return;
    validateCliOptions(actionCommand);
  });
}
