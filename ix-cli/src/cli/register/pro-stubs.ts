// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { PRO_COMMANDS, PRO_RETIRED, PRO_STUB } from "./pro-surface.js";

/**
 * Register a hidden stand-in for every Pro command, and every retired Pro
 * name, that is not already registered. The names come from the one table in
 * pro-surface.ts (#932).
 */
export function registerProStubs(program: Command): void {
  const registered = new Set(program.commands.map((c: Command) => c.name()));
  const stubs: { name: string; desc: string; lines: string[] }[] = [
    ...PRO_COMMANDS.map(({ name, description }) => ({
      name,
      desc: description,
      lines: [`The '${name}' command requires Ix Pro.`],
    })),
    // A retired name is not a command anywhere, Pro included. Its replacement
    // is a Pro command, so say both: the sentinel agents stop on (naming the
    // command that exists) and the form to use once Pro is installed.
    ...Object.entries(PRO_RETIRED).map(([old, now]) => {
      const current = now.split(" ")[0];
      return {
        name: old,
        desc: `Retired: use 'ix ${now}'`,
        lines: [`The '${current}' command requires Ix Pro.`, `'ix ${old}' is now 'ix ${now}'.`],
      };
    }),
  ];
  for (const { name, desc, lines } of stubs) {
    if (registered.has(name)) continue;
    const stub = program
      .command(name)
      .description(desc)
      // Swallow whatever the caller passed. `allowUnknownOption` alone only
      // covers flags; commander still rejects excess *operands*, and it does so
      // before the action runs. So `ix bug` reached this message but
      // `ix bug create "title" --affects Entity` — the form the docs and every
      // agent actually use — died with "too many arguments for 'bug'" and never
      // said anything about Pro. The subcommand and its arguments are
      // deliberately ignored: the only thing worth saying here is that the
      // whole command needs Pro.
      .argument("[args...]")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(() => {
        for (const line of lines) console.error(line);
        console.error(`Install @ix/pro to enable premium features.`);
        process.exitCode = 1;
      });
    (stub as any).hidden = true;
    (stub as unknown as Record<symbol, unknown>)[PRO_STUB] = true;
  }
}
