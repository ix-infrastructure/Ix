// Copyright 2026 Ix Infrastructure Inc.

import type { RunCommandResult } from "./run-command.js";

/**
 * Normalise what `runCommand` captured so a snapshot of it is the same on
 * every run and every OS. Only what differs per run is touched:
 *
 *   - the run's temp directory (scratch IX_HOME, workspace and unmapped
 *     directory all live under it), in any of the forms it is printed in
 *     (native, JSON-escaped, forward-slashed), becomes `<TMP>`, and the
 *     separators in the path after it become `/`; an llm value that is only
 *     such a path loses the quotes Windows' backslashes gave it;
 *   - the FakeBackend's port becomes `<PORT>`. With `opts.port`, only that
 *     port is replaced, so another fixed endpoint a test points at (say an
 *     unreachable `127.0.0.1:1`) prints as it is; without it, any port on
 *     127.0.0.1 is.
 */
export function normalise(
  text: string,
  run: Pick<RunCommandResult, "tempRoot">,
  opts: { port?: string } = {},
): string {
  const root = run.tempRoot;
  const forms = new Set([root, root.replace(/\\/g, "/"), JSON.stringify(root).slice(1, -1)]);
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    // The root, then the rest of the path: any run of path characters and separators.
    // A separator is `/`, `\`, or `\\` (a backslash JSON-escaped).
    const pattern = new RegExp(`${escapeRegExp(form)}((?:(?:\\\\\\\\|[\\\\/])[\\w.-]+)*)`, "g");
    out = out.replace(pattern, (_m, rest: string) => `<TMP>${rest.replace(/\\\\|\\/g, "/")}`);
  }
  // `--format llm` quotes a value holding a `\` (llm.ts), so on Windows a bare
  // path prints as dir="C:\\...". Once it is `<TMP>/...` it needs no quoting:
  // print it as it prints on POSIX.
  out = out.replace(/="(<TMP>(?:\/[\w.-]+)*)"/g, "=$1");
  const port = opts.port === undefined ? "\\d+" : `${escapeRegExp(opts.port)}(?!\\d)`;
  return out.replace(new RegExp(`127\\.0\\.0\\.1:${port}`, "g"), "127.0.0.1:<PORT>");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
