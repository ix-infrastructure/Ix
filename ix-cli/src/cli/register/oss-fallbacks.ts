// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

/**
 * Commands OSS implements against the local backend, but which Ix Pro also
 * registers, with the same flags and `--json` output, against the active cloud
 * org. On a Pro install Pro's must win: a note written there has to land in
 * the org's memory layer, not on a backend the user may not even run.
 *
 * That rules out `registerOssCommands()` (`register/oss.ts`). OSS registers
 * first, and commander keeps the first registration of a name: Pro's
 * `tryRegister` would throw on the duplicate, report "failed to load note" on
 * every invocation, and leave the user on the local backend. So these register
 * only where `registerProStubs` does, once Pro is known not to have loaded,
 * and they are not part of the OSS set `run-cli.ts` snapshots: in `ix --help`
 * they are listed by `buildHelpText()` when Pro is absent, and under Pro's
 * section when it is present.
 *
 * Like a Pro command, they get none of `applyOssSetup`'s option handling
 * (`--format` choices and default, `--pretty`/`--quiet`/`--fields`), so they
 * parse exactly the flags Pro's versions do.
 */
type RegisterCommand = (program: Command) => void;

export const OSS_FALLBACK_TABLE: Readonly<Record<string, () => Promise<RegisterCommand>>> = {
  note: async () => (await import("../commands/note.js")).registerNoteCommand,
  session: async () => (await import("../commands/session.js")).registerSessionCommand,
};

/**
 * Register each fallback `program` has no command for yet. Call only once Pro
 * has not loaded (absent, or broken and running a repair command): a Pro whose
 * own `note` failed to load must not be quietly replaced by a local one.
 * `only` limits it to one command, for the startup fast path.
 */
export async function registerOssFallbacks(program: Command, only?: string): Promise<void> {
  const registered = new Set(program.commands.map((c) => c.name()));
  for (const [name, load] of Object.entries(OSS_FALLBACK_TABLE)) {
    if (only !== undefined && name !== only) continue;
    if (registered.has(name)) continue;
    (await load())(program);
  }
}
