#!/usr/bin/env node
import { Command } from "commander";
import { registerOssCommands, registerProStubs } from "./register/oss.js";
import { tryLoadProCommands } from "./register/pro-loader.js";
import { buildHelpText } from "./help-text.js";

const program = new Command();
program
  .name("ix")
  .version("0.1.0");

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

  program.parse();
})();
