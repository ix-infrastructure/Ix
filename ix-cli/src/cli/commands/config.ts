// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { loadConfig, updateConfig, type WorkspaceConfig } from "../config.js";
import {
  BUILT_IN_DEFAULT_FORMAT,
  DEFAULT_FORMAT_CHOICES,
  isFormat,
  resolveDefaultFormat,
} from "../default-format.js";

/** Resolve a dotted key path into a config object and return [obj, lastKey]. */
function resolvePath(obj: any, key: string): [any, string] {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === undefined) cur[part] = {};
    cur = cur[part];
  }
  return [cur, parts[parts.length - 1]];
}

/** Keys whose values `ix config show` never prints: the config holds credentials. */
const SECRET_KEY = /token|secret|jwt|password/i;

/** A value as `show` prints it: secrets as a marker, never their text. */
export function displayValue(key: string, value: unknown): string {
  return SECRET_KEY.test(key) ? "(redacted)" : String(value);
}

/**
 * Why `ix config set <key> <value>` must refuse, or undefined to allow it.
 * `workspaces` is a list `ix map` maintains; a string written over it lost
 * every registration. `endpoint` must be a URL the client can call.
 */
export function rejectSet(key: string, value: string): string | undefined {
  const top = key.split(".")[0];
  if (top === "workspaces") return "workspaces is managed by `ix map` and `ix config prune`; it cannot be set by hand.";
  if (key === "endpoint") {
    let url: URL;
    try { url = new URL(value); } catch { return `Not a URL: ${value}`; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return `The endpoint must be http:// or https://, not ${url.protocol}`;
  }
  return undefined;
}

/** Registered workspaces whose root no longer exists on disk. */
export function staleWorkspaces(workspaces: readonly WorkspaceConfig[], exists: (p: string) => boolean = existsSync): WorkspaceConfig[] {
  return workspaces.filter((w) => !exists(w.root_path));
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Show or update Ix configuration");

  config
    .command("show")
    .description("Show current configuration")
    .action(() => {
      const cfg = loadConfig();
      console.log(chalk.bold("Ix Configuration\n"));
      console.log(`  endpoint    ${chalk.cyan(cfg.endpoint)}`);
      console.log(`  format      ${chalk.cyan(cfg.format)}${formatOverrideNote(cfg.format)}`);
      if (cfg.workspaces?.length) {
        console.log(`  workspaces`);
        for (const ws of cfg.workspaces) {
          const marker = ws.default ? chalk.green(" (default)") : "";
          console.log(`    ${chalk.bold(ws.workspace_name)}${marker}  ${chalk.dim(ws.root_path)}`);
        }
      }
      // Print any extra keys (user.name, team.name, etc.)
      const known = new Set(["endpoint", "format", "workspaces"]);
      for (const [k, v] of Object.entries(cfg)) {
        if (known.has(k)) continue;
        if (typeof v === "object" && v !== null) {
          for (const [k2, v2] of Object.entries(v as object)) {
            // Nested objects (Pro's instances) are summarised, not dumped: they
            // carry tunnel JWTs and refresh tokens.
            const shown = typeof v2 === "object" && v2 !== null ? "(…)" : displayValue(`${k}.${k2}`, v2);
            console.log(`  ${k}.${k2}    ${chalk.cyan(shown)}`);
          }
        } else {
          console.log(`  ${k}    ${chalk.cyan(displayValue(k, v))}`);
        }
      }
    });

  config
    .command("get <key>")
    .description("Get a config value (e.g. endpoint, user.name)")
    .action((key: string) => {
      const cfg = loadConfig() as any;
      const [obj, lastKey] = resolvePath(cfg, key);
      const val = obj[lastKey];
      if (val === undefined) {
        console.error(chalk.red(`Key not found: ${key}`));
        process.exitCode = 1;
        return;
      }
      console.log(val);
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (e.g. ix config set user.name 'Alice')")
    .action((key: string, value: string) => {
      // `format` is the one key here that changes what every other command
      // prints. A typo used to save silently and then do nothing at all, since
      // an unrecognised value falls back to text.
      if (key === "format" && !isFormat(value)) {
        console.error(chalk.red(`Not a format: ${value}`));
        console.error(`Choose one of: ${DEFAULT_FORMAT_CHOICES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const refused = rejectSet(key, value);
      if (refused) {
        console.error(chalk.red(refused));
        process.exitCode = 1;
        return;
      }
      updateConfig((cfg) => {
        const [obj, lastKey] = resolvePath(cfg, key);
        obj[lastKey] = value;
        return { save: cfg, result: undefined };
      });
      console.log(chalk.green("✓") + ` ${key} = ${chalk.cyan(displayValue(key, value))}`);
    });

  config
    .command("prune")
    .description("Remove registered workspaces whose directory no longer exists")
    .option("--dry-run", "List what would be removed without changing anything")
    .action((opts: { dryRun?: boolean }) => {
      if (opts.dryRun) {
        const stale = staleWorkspaces(loadConfig().workspaces ?? []);
        if (stale.length === 0) console.log("No registered workspace is missing.");
        for (const w of stale) console.log(`would remove ${w.workspace_name}  ${chalk.dim(w.root_path)}`);
        return;
      }
      const removed = updateConfig((cfg) => {
        const stale = staleWorkspaces(cfg.workspaces ?? []);
        if (stale.length === 0) return { result: stale };
        const gone = new Set(stale);
        const kept = (cfg.workspaces ?? []).filter((w) => !gone.has(w));
        // Keep exactly one default when the default was among the removed.
        if (kept.length > 0 && !kept.some((w) => w.default)) kept[0] = { ...kept[0]!, default: true };
        return { save: { ...cfg, workspaces: kept }, result: stale };
      });
      if (removed.length === 0) console.log("No registered workspace is missing.");
      for (const w of removed) console.log(`${chalk.green("✓")} removed ${w.workspace_name}  ${chalk.dim(w.root_path)}`);
      // Unregistering does not touch the backend: say so rather than imply the
      // graphs went with the entries.
      if (removed.length > 0) console.log(chalk.dim("  Their graphs stay in the backend."));
    });
}

/**
 * What `ix config show` adds beside a stored format that is not the one
 * commands will actually use, because IX_FORMAT outranks it.
 */
function formatOverrideNote(stored: string): string {
  const { format, ignored } = resolveDefaultFormat(process.env, () => stored);
  if (ignored?.source === "IX_FORMAT") {
    return chalk.dim(`  (IX_FORMAT=${ignored.value} ignored: not a format)`);
  }
  if (format !== (stored || BUILT_IN_DEFAULT_FORMAT)) {
    return chalk.dim(`  (overridden by IX_FORMAT=${format})`);
  }
  return "";
}
