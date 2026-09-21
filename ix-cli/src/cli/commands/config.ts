// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
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
            console.log(`  ${k}.${k2}    ${chalk.cyan(String(v2))}`);
          }
        } else {
          console.log(`  ${k}    ${chalk.cyan(String(v))}`);
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
      const cfg = loadConfig() as any;
      const [obj, lastKey] = resolvePath(cfg, key);
      obj[lastKey] = value;
      saveConfig(cfg);
      console.log(chalk.green("✓") + ` ${key} = ${chalk.cyan(value)}`);
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
