#!/usr/bin/env node
import { Command } from "commander";
import { registerOssCommands, registerProStubs } from "./register/oss.js";
import { tryLoadProCommands } from "./register/pro-loader.js";
import { buildHelpText } from "./help-text.js";
import { checkForUpdate } from "./commands/upgrade.js";

import { readFileSync } from "fs";
import { join } from "path";

let cliVersion = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
  cliVersion = pkg.version || "0.0.0";
} catch {}

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
    checkForUpdate();
  }

  program.parse();
})();
