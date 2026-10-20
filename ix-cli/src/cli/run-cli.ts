// Copyright 2026 Ix Infrastructure Inc.

// The CLI proper. `main.ts` is the entry point: it checks the Node version and
// turns on the compile cache, then imports this module, so everything below
// -- every command module and its dependencies -- loads through the cache.
// Which command modules load at all is `planStartup`'s call
// (`register/oss-table.ts`): usually just the one being run. The invocation
// itself is `cli-invocation.ts`, shared with the warm daemon.

import { detectRequestedFormat, renderCliError, setErrorFormat } from "./errors.js";
import { prepareInvocation, runInvocation, safeEndpoint } from "./cli-invocation.js";

// Set IX_DEBUG=1 to append stack traces to any rendered error.
const debug = process.env.IX_DEBUG === "1";

// Before anything can throw. The handlers below are installed for
// `unhandledRejection` and `uncaughtException`, which can fire before
// commander has parsed a thing, so the error boundary gets the format from
// argv rather than from a parsed command.
setErrorFormat(detectRequestedFormat(process.argv.slice(2)));

// Last line of defence. Without these, any rejection escaping a command — most
// commonly the backend not running — reaches Node's default handler and prints
// an undici stack trace that exposes internal paths and tells the user nothing.
process.on("unhandledRejection", (err: unknown) => {
  renderCliError(err, debug, safeEndpoint());
});
process.on("uncaughtException", (err: unknown) => {
  renderCliError(err, debug, safeEndpoint());
});

const { program, lazy } = await prepareInvocation(process.argv.slice(2));

void runInvocation(program, lazy, { debug });
