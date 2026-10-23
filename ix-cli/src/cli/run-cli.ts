// Copyright 2026 Ix Infrastructure Inc.

// The CLI proper. `main.ts` is the entry point: it checks the Node version and
// turns on the compile cache, then imports this module, so everything below
// -- every command module and its dependencies -- loads through the cache.
// Which command modules load at all is `planStartup`'s call
// (`register/oss-table.ts`): usually just the one being run.

import { Command } from "commander";
import { registerProStubs } from "./register/pro-stubs.js";
import { planStartup, registerForPlan } from "./register/oss-table.js";
import { tryLoadProCommands } from "./register/pro-loader.js";
import { isRepairInvocation } from "./register/pro-failure.js";
import { buildHelpText } from "./help-text.js";
import { stderrIsTerminal } from "./stderr.js";
import { detectRequestedFormat, renderCliError, setErrorFormat } from "./errors.js";
import { getEndpoint } from "./config.js";

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let cliVersion = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
  cliVersion = pkg.version || "0.0.0";
} catch {}

// Set IX_DEBUG=1 to append stack traces to any rendered error.
const debug = process.env.IX_DEBUG === "1";

// Before anything can throw. The handlers below are installed for
// `unhandledRejection` and `uncaughtException`, which can fire before
// commander has parsed a thing, so the error boundary gets the format from
// argv rather than from a parsed command.
setErrorFormat(detectRequestedFormat(process.argv.slice(2)));

// Resolving the endpoint reads config off disk, which can itself fail. An
// error renderer must never throw, so failure here just drops the endpoint
// from the message rather than replacing one crash with another.
function safeEndpoint(): string | undefined {
  try {
    return getEndpoint();
  } catch {
    return undefined;
  }
}

// Last line of defence. Without these, any rejection escaping a command — most
// commonly the backend not running — reaches Node's default handler and prints
// an undici stack trace that exposes internal paths and tells the user nothing.
process.on("unhandledRejection", (err: unknown) => {
  renderCliError(err, debug, safeEndpoint());
});
process.on("uncaughtException", (err: unknown) => {
  renderCliError(err, debug, safeEndpoint());
});

const program = new Command();
program
  .name("ix")
  .version(cliVersion);

// Start with OSS-only help; updated after Pro probe.
program.helpInformation = () => buildHelpText();

// Every OSS command, or only the one this invocation runs. The second happens
// only with Pro absent, so `lazy` also means there is no Pro to load.
const lazy = await registerForPlan(program, planStartup(process.argv.slice(2)));

(async () => {
  const ossCmdNames = new Set(program.commands.map((c: Command) => c.name()));

  // An installed-but-broken Pro throws here rather than reporting absence, so
  // commands never run without its credential guard. Note this call sits
  // OUTSIDE the parseAsync try/catch below — render the failure here rather
  // than letting it reach the unhandledRejection handler by accident.
  let proLoaded = false;
  // `ix hook` runs inside an agent harness after every edit and must exit 0
  // with nothing on stdout whenever it cannot help. A broken Pro install would
  // otherwise make it exit 1 before its action runs, and it needs nothing Pro
  // registers.
  const isHook = process.argv[2] === "hook";
  try {
    if (!isHook && !lazy) proLoaded = await tryLoadProCommands(program);
  } catch (err) {
    if (!isRepairInvocation(process.argv)) {
      renderCliError(err, debug, safeEndpoint()); // exits 1
    }
    // Repair invocation: continue OSS-only. proLoaded stays false, so the Pro
    // stubs register below and would misreport a broken Pro as absent — the
    // warning here is what distinguishes the two, and no command in the set
    // above reaches a stub.
    console.error(
      "[!!] Ix Pro is installed but failed to initialize; continuing with OSS " +
      "commands only so this one can repair the install.",
    );
  }
  if (proLoaded) {
    // Collect commands that Pro added (weren't in OSS set)
    const proCommands = program.commands
      .filter((c: Command) => !ossCmdNames.has(c.name()))
      .map((c: Command) => ({ name: c.name(), desc: c.description() }));

    program.helpInformation = () => buildHelpText(proCommands);
  } else {
    registerProStubs(program);
  }

  // Check for updates (non-blocking, cached 1hr). Only when a person is
  // watching stderr — see updateCheckEnabled for why, and for the
  // IX_NO_UPDATE_CHECK opt-out.
  // `updateCheckEnabled` is false whenever stderr is not a terminal, which is
  // every agent and hook call, so only a person's pays for loading it.
  const args = process.argv.slice(2);
  const updates = stderrIsTerminal() ? await import("./commands/upgrade.js") : undefined;
  if (updates?.updateCheckEnabled(args, process.env, true)) {
    // Deliberately not awaited — but it must still be caught here. The catch
    // inside checkForUpdate only guards its inner fetch chain; the function's
    // own promise covers the synchronous cached-read path, and a corrupt
    // ~/.ix/.version-check.json makes that throw. Uncaught, the new
    // unhandledRejection handler then aborts a command that already succeeded.
    updates.checkForUpdate().catch(() => {});
  }

  // parseAsync (not parse) so rejections from async action handlers surface
  // here instead of floating off as unhandled rejections.
  try {
    await program.parseAsync();
  } catch (err) {
    renderCliError(err, debug, safeEndpoint());
  }
})();
