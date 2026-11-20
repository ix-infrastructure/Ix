// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { applyOssSetup } from "./oss-setup.js";
import { proIsAbsent } from "./pro-loader.js";
import { OSS_FALLBACK_TABLE, registerOssFallbacks } from "./oss-fallbacks.js";
import { OSS_COMMANDS, type RegisterCommand } from "./commands.js";

/**
 * Which module registers each OSS command, so the CLI can load only the one
 * being run.
 *
 * `registerOssCommands()` (`register/oss.ts`) loads all ~40 command modules
 * and everything they depend on, on every call, `--version` included, before
 * the command does anything. Agents and plugin hooks call `ix` far more
 * often than a person does, and compare it with `rg`, which has answered by
 * then. So `run-cli.ts` asks `planStartup` first and, where it can, registers
 * the one command instead.
 *
 * Keyed by every top-level name and alias in the manifest
 * (`register/commands.ts`), which `registerOssCommands()` registers from too;
 * a module that registers two commands (`callers` and `callees`) appears under
 * both.
 */
export const OSS_COMMAND_TABLE: Readonly<Record<string, () => Promise<RegisterCommand>>> = Object.fromEntries(
  OSS_COMMANDS.flatMap((entry) => entry.names.map((name) => [name, entry.load] as const)),
);

/**
 * Commands that read the registry itself. `ix help <topic>` looks the topic up
 * among every registered command, so it needs all of them.
 */
const NEEDS_EVERY_COMMAND = new Set(["help"]);

/** Set to `1` to register every command, as before the table existed. */
export const LOAD_ALL_COMMANDS_ENV = "IX_LOAD_ALL_COMMANDS";

export type StartupPlan =
  | { kind: "all" }
  | { kind: "version" }
  | { kind: "command"; name: string; load: () => Promise<RegisterCommand> }
  | { kind: "fallback"; name: string };

/**
 * How much of the command registry this invocation needs. `args` is argv
 * without the node and script paths.
 *
 * Only two shapes get less than everything, and only with Pro absent:
 *
 * - `ix --version` / `ix -V` alone: no command at all.
 * - `ix <name> ...` where `<name>` is the first token and in the table: that
 *   command's module. Likewise for a name in `OSS_FALLBACK_TABLE`
 *   (`ix note`, `ix session`), which with Pro absent are OSS's to answer.
 *
 * Everything else registers all of them, because commander needs the whole
 * list to answer it: root help (`ix`, `ix --help`, `ix help ...`), an unknown
 * word ("did you mean"), a Pro command or stub, or an option before the
 * command word. With Pro installed it is always everything: Pro registers
 * against the same program after OSS and can collide with an OSS name
 * (`patches`), where whichever registered first wins.
 */
export function planStartup(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  isProAbsent: () => boolean = proIsAbsent,
): StartupPlan {
  if (env[LOAD_ALL_COMMANDS_ENV] === "1") return { kind: "all" };
  const word = args[0];
  if (word === undefined) return { kind: "all" };
  const versionOnly = args.length === 1 && (word === "--version" || word === "-V");
  const known = !NEEDS_EVERY_COMMAND.has(word) && Object.hasOwn(OSS_COMMAND_TABLE, word);
  const fallback = Object.hasOwn(OSS_FALLBACK_TABLE, word);
  if (!versionOnly && !known && !fallback) return { kind: "all" };
  // Last: the only check here that touches the filesystem.
  if (!isProAbsent()) return { kind: "all" };
  if (versionOnly) return { kind: "version" };
  // A fallback (`register/oss-fallbacks.ts`) is only ever OSS's with Pro absent,
  // which is the one case this plan is made in.
  if (fallback) return { kind: "fallback", name: word };
  return { kind: "command", name: word, load: OSS_COMMAND_TABLE[word] };
}

/**
 * Register what `plan` calls for on `program`, with the same per-command setup
 * `registerOssCommands()` applies. True when that was less than every command
 * -- which `planStartup` only allows with Pro absent.
 */
export async function registerForPlan(program: Command, plan: StartupPlan): Promise<boolean> {
  if (plan.kind === "all") {
    const { registerOssCommands } = await import("./oss.js");
    registerOssCommands(program);
    return false;
  }
  if (plan.kind === "command") (await plan.load())(program);
  applyOssSetup(program);
  // After the setup, as in the full path: a fallback is configured like Pro's
  // command it stands in for, not like an OSS one.
  if (plan.kind === "fallback") await registerOssFallbacks(program, plan.name);
  return true;
}
