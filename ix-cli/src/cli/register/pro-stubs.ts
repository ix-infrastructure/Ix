// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

const PRO_COMMANDS: { name: string; desc: string }[] = [
  { name: "briefing", desc: "Session-resume briefing" },
  { name: "bug", desc: "Manage bugs" },
  { name: "decide", desc: "Record a design decision" },
  { name: "decisions", desc: "List recorded design decisions" },
  { name: "goal", desc: "Manage project goals" },
  { name: "goals", desc: "List all goals" },
  // `patches` is deliberately absent: ix-cli owns the real implementation
  // (commands/patches.ts, registered by `registerOssCommands` in oss.ts and
  // listed in oss-table.ts). It sat in this list while never
  // being registered, so `ix patches` answered "requires Ix Pro" on OSS and
  // shadowed a working command — see #371.
  { name: "plan", desc: "Manage plans and plan tasks" },
  { name: "task", desc: "Manage tasks" },
  { name: "plans", desc: "List all plans" },
  { name: "tasks", desc: "List all tasks across plans" },
  { name: "truth", desc: "Manage project intents (truth)" },
  { name: "workflow", desc: "Attach, show, validate, or run staged workflows" },
];

export function registerProStubs(program: Command): void {
  const registered = new Set(program.commands.map((c: Command) => c.name()));
  for (const { name, desc } of PRO_COMMANDS) {
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
        console.error(`The '${name}' command requires Ix Pro.`);
        console.error(`Install @ix/pro to enable premium features.`);
        process.exitCode = 1;
      });
    (stub as any).hidden = true;
  }
}
