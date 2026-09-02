#!/usr/bin/env node
/**
 * Print the CLI's registered command/flag surface as JSON, one object per
 * command (subcommands included, `parent sub` as the name).
 *
 * The point is that `skills/ix/references/flags.md` is checked against the
 * *registered commander tree* rather than against a regex over source or, worse,
 * someone's memory of what a command took. #575 measured 27 of 76 implemented
 * flags documented; the gap was not carelessness, it was that nothing connected
 * the two surfaces.
 *
 * Needs a build first (`npm run build`) — it imports `dist/`, not `src/`,
 * because that is what actually ships.
 *
 *   node scripts/dump-cli-surface.mjs            # JSON to stdout
 *   node scripts/dump-cli-surface.mjs --flags    # one long flag per line, sorted
 *
 * Deliberately NOT wired into CI: what a parity gate should block on is the
 * open question in #576, and this is the inventory half either answer needs.
 */
import { Command } from "commander";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ossPath = join(here, "..", "dist", "cli", "register", "oss.js");

let registerOssCommands;
try {
  ({ registerOssCommands } = await import(pathToFileURL(ossPath).href));
} catch (err) {
  process.stderr.write(
    `cannot load ${ossPath}\nRun 'npm run build' in ix-cli first.\n${err}\n`,
  );
  process.exit(1);
}

const program = new Command();
program.name("ix");
registerOssCommands(program);

const commands = [];
function walk(cmd, parentPath) {
  const name = parentPath ? `${parentPath} ${cmd.name()}` : cmd.name();
  commands.push({
    command: name,
    description: cmd.description(),
    arguments: (cmd.registeredArguments ?? []).map(a => ({
      name: a.name(),
      required: a.required,
    })),
    options: (cmd.options ?? []).map(o => ({
      flags: o.flags,
      long: o.long,
      short: o.short,
      description: o.description,
      default: o.defaultValue === undefined ? null : String(o.defaultValue),
      choices: o.argChoices ?? null,
    })),
    subcommands: (cmd.commands ?? []).map(c => c.name()),
  });
  for (const sub of cmd.commands ?? []) walk(sub, name);
}
for (const cmd of program.commands) walk(cmd, "");

if (process.argv.includes("--flags")) {
  const longs = new Set();
  for (const c of commands) for (const o of c.options) if (o.long) longs.add(o.long);
  for (const f of [...longs].sort()) console.log(f);
} else {
  console.log(JSON.stringify(commands, null, 2));
}
