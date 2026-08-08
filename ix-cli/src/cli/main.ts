#!/usr/bin/env node
import { Command } from "commander";
import { registerOssCommands, registerProStubs } from "./register/oss.js";
import { tryLoadProCommands } from "./register/pro-loader.js";
import { buildHelpText } from "./help-text.js";
import { checkForUpdate } from "./commands/upgrade.js";
import { renderCliError } from "./errors.js";
import { getEndpoint } from "./config.js";

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Runtime Node version guard. Runs before any command work so users on an
// unsupported Node get an actionable message instead of a cryptic "fetch
// failed" deep inside undici.
const MIN_NODE_MAJOR = 20;
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

let cliVersion = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
  cliVersion = pkg.version || "0.0.0";
} catch {}

// Set IX_DEBUG=1 to append stack traces to any rendered error.
const debug = process.env.IX_DEBUG === "1";

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

registerOssCommands(program);

(async () => {
  const ossCmdNames = new Set(program.commands.map((c: Command) => c.name()));

  const proLoaded = await tryLoadProCommands(program);
  if (proLoaded) {
    // Collect commands that Pro added (weren't in OSS set)
    const proCommands = program.commands
      .filter((c: Command) => !ossCmdNames.has(c.name()))
      .map((c: Command) => ({ name: c.name(), desc: c.description() }));

    program.helpInformation = () => buildHelpText(proCommands);
  } else {
    registerProStubs(program);
  }

  // Check for updates (non-blocking, cached 1hr) — skip for upgrade command itself
  const args = process.argv.slice(2);
  if (args[0] !== "upgrade") {
    // Deliberately not awaited — but it must still be caught here. The catch
    // inside checkForUpdate only guards its inner fetch chain; the function's
    // own promise covers the synchronous cached-read path, and a corrupt
    // ~/.ix/.version-check.json makes that throw. Uncaught, the new
    // unhandledRejection handler then aborts a command that already succeeded.
    checkForUpdate().catch(() => {});
  }

  // parseAsync (not parse) so rejections from async action handlers surface
  // here instead of floating off as unhandled rejections.
  try {
    await program.parseAsync();
  } catch (err) {
    renderCliError(err, debug, safeEndpoint());
  }
})();
