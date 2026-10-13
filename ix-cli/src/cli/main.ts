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
// first request on a warm machine. Node >= 22.1 keeps the cache under the OS
// temp directory, keyed by file content and Node version, so an upgrade can
// never run stale code; NODE_COMPILE_CACHE moves it and
// NODE_DISABLE_COMPILE_CACHE=1 turns it off. Absent on 22.0: then a no-op.
try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
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
const args = process.argv.slice(2);
// `ix __map-refresh <root>` is the detached background map refresh a region
// view starts (`map-freshness.ts`); it is not a command anyone types, so it
// skips the command tree too. It exits when done, whatever is left pending.
if (args[0] === "__map-refresh" && args[1] !== undefined) {
  const { runBackgroundMapRefresh } = await import("./map-freshness.js");
  try { await runBackgroundMapRefresh(args[1]); } catch { /* recorded where it could be */ }
  process.exit(0);
} else if (args[0] === "hook" && args[1] === "claude-post-edit" && !args.some((a) => a === "-h" || a === "--help")) {
  const { parseHookArgs, runHookProcess } = await import("./hook/entry.js");
  await runHookProcess(parseHookArgs(args.slice(2)));
} else {
  await import("./run-cli.js");
}
