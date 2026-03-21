import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";

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
      console.log(`  format      ${chalk.cyan(cfg.format)}`);
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
      const cfg = loadConfig() as any;
      const [obj, lastKey] = resolvePath(cfg, key);
      obj[lastKey] = value;
      saveConfig(cfg);
      console.log(chalk.green("✓") + ` ${key} = ${chalk.cyan(value)}`);
    });
}
