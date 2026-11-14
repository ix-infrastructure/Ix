// Copyright 2026 Ix Infrastructure Inc.

/**
 * Every `ix hook` subcommand, in one list. `main.ts` runs any of them before
 * the CLI's command tree loads: an agent host runs a hook on every hooked
 * event, and the tree costs more than most hooks' whole answer. Each entry
 * loads its own code only when run. `commands/hook.ts` registers the same
 * names for `--help` and the full CLI; a test holds the two to each other.
 *
 * Each runs as the hook process contract in `io.ts` says: exit 0, print
 * nothing or exactly the host's JSON, one deadline per run.
 */

type HookRunner = (argv: string[]) => Promise<void>;

export const HOOK_SUBCOMMANDS: Readonly<Record<string, HookRunner>> = Object.freeze({
  "claude-post-edit": async (argv: string[]) => {
    const { parseHookArgs, runHookProcess } = await import("./entry.js");
    await runHookProcess(parseHookArgs(argv));
  },
  "auto-map": async (argv: string[]) => {
    const { parseAutoMapArgs, runAutoMapProcess } = await import("./auto-map.js");
    await runAutoMapProcess(parseAutoMapArgs(argv));
  },
});

/** The runner for `ix hook <name>`, or undefined when `name` is not a hook subcommand. */
export function hookSubcommand(name: string | undefined): HookRunner | undefined {
  return name !== undefined && Object.hasOwn(HOOK_SUBCOMMANDS, name) ? HOOK_SUBCOMMANDS[name] : undefined;
}
