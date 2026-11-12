// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which invocations survive an installed-but-broken `@ix/pro`.
 *
 * `tryLoadProCommands` throws rather than reporting absence when Pro is
 * installed and cannot initialize, so no command runs without its credential
 * guard. Taken literally that also kills `ix upgrade` — the command the thrown
 * message tells the user to run, and the only in-CLI way to reinstall the
 * pair. That leaves hand-run npm as the sole route out of a broken install.
 *
 * These invocations are allowed through OSS-only instead. None of them carries
 * Pro behaviour: `upgrade` reinstalls, the others only report. Everything else
 * — every command that could touch the graph or the cloud — still stops.
 *
 * A bare `ix` (no argument) deliberately stops: the initialization error is
 * more useful to someone staring at a broken install than the help text is.
 */
const REPAIR_INVOCATIONS = new Set([
  "upgrade",
  "status",
  "doctor",
  "config",
  "docker",
  // MCP hosts launch the server as the bare command `ix mcp` (see
  // mcp/hosts.ts, which writes `command: "ix", args: ["mcp"]`). Without this
  // the server exits before the mcp command is ever reached, so the host sees
  // only a dead server and `detectPro`'s own handling never runs. Allowing it
  // does not weaken anything: `detectPro` then declines to advertise the Pro
  // tools, and `buildProgram` still rejects for any call that would need them.
  "mcp",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
]);

/**
 * True when `argv` (process.argv, whole) names an invocation that must keep
 * working after an installed Pro fails to initialize.
 */
export function isRepairInvocation(argv: readonly string[]): boolean {
  return REPAIR_INVOCATIONS.has(argv[2] ?? "");
}

/**
 * True when `argv` (process.argv, whole) is `ix map --auto`: what an editor or
 * agent hook runs after every edit, promised to print nothing and exit 0. An
 * installed Pro that fails to initialize must not make it exit 1; with Pro
 * broken the remote check cannot be trusted, so it maps nothing instead.
 */
export function isAutoMapInvocation(argv: readonly string[]): boolean {
  return argv[2] === "map" && argv.slice(3).includes("--auto");
}
