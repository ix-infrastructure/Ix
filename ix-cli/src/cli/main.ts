#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

// The entry point, kept to what must happen before the CLI's own modules load.
// Static imports are evaluated before a module's body runs, so the steps
// below could not live in `run-cli.ts`: by the time its first line ran, the
// ~200 modules behind the command registry would already be loaded.

import * as nodeModule from "node:module";

// Runtime Node version guard. Runs before any command work so users on an
// unsupported Node get an actionable message instead of a cryptic "fetch
// failed" deep inside undici.
const MIN_NODE_MAJOR = 22;
{
  const current = process.versions.node;
  const major = parseInt(current.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `Ix requires Node.js ${MIN_NODE_MAJOR} or newer. You are running v${current}.\n` +
      `Install a supported version from https://nodejs.org/ and re-run.\n`
    );
    process.exit(1);
  }
}

// V8's code cache for every module loaded from here on. Compiling the CLI's
// modules is most of its start-up: measured at ~40 ms of ~180 ms before the
// first request on a warm machine. Node >= 22.1 keys the cache by file content
// and Node version, so an upgrade can never run stale code, and keeps it in
// its default place under the OS temp directory, which the OS cleans: caches
// left behind by older Node versions do not pile up in Ix's own state.
// Node's own settings win, and then this calls nothing: NODE_COMPILE_CACHE has
// already been applied before this line runs, and NODE_DISABLE_COMPILE_CACHE
// (any value, as Node reads it) turns the cache off. Absent on 22.0: then a
// no-op. A directory that cannot be created or written is reported in the
// return value, which is ignored: it only costs speed.
try {
  const { enableCompileCache } = nodeModule as { enableCompileCache?: () => unknown };
  if (enableCompileCache && process.env.NODE_COMPILE_CACHE === undefined && process.env.NODE_DISABLE_COMPILE_CACHE === undefined) {
    enableCompileCache();
  }
} catch {
  // A cache that cannot be opened only costs speed.
}

// Everything but one invocation goes straight to the CLI (`run-cli.ts`). The
// exception is `ix hook claude-post-edit`, which an agent harness runs after
// every hooked tool call -- every Bash command included -- and which almost
// always has nothing to say. Loading the CLI's command tree costs ~140 ms
// before a single line of it runs; the hook's "nothing changed" answer costs a
// git call. So the hook is dispatched here, before that tree is loaded, and
// loads the graph code itself only when there is an edit to report.
// `--help` still goes through the CLI, where the command is documented.
//
// Before either: on Linux and macOS, an agent-facing call (stdout and stderr
// not a terminal, a read-only command) is answered by the warm per-user daemon
// when one is running, with the same output and exit code -- see
// `daemon/client.ts`. A call it does not answer runs below as it always has,
// and the first such call starts the daemon for the next one. IX_DAEMON=off
// turns it off.
const args = process.argv.slice(2);
const answered = process.platform !== "win32" && process.env.IX_DAEMON !== "off" &&
  await (await import("./daemon/client.js")).answerFromDaemon(args);
if (answered) {
  // Written, and process.exitCode set: nothing more to load.
} else if (args[0] === "hook" && args[1] === "claude-post-edit" && !args.some((a) => a === "-h" || a === "--help")) {
  const { parseHookArgs, runHookProcess } = await import("./hook/entry.js");
  await runHookProcess(parseHookArgs(args.slice(2)));
} else {
  await import("./run-cli.js");
}
