// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { OSS_COMMANDS, ROOT_HELP_SECTIONS, type HelpLine } from "./register/commands.js";

/** Where a summary starts, as the hand-written help always had it. */
const USAGE_WIDTH = 22;

/**
 * The OSS part of `ix --help`, built from the command manifest
 * (`register/commands.ts`): each section's help lines, in the section's order.
 */
function ossHelp(): string {
  const lines = new Map<string, HelpLine>();
  for (const entry of OSS_COMMANDS) {
    for (const line of entry.help ?? []) lines.set(line.usage.split(" ")[0], line);
  }
  const out = [`${chalk.cyan("ix")} — System Intelligence CLI`, ``];
  for (const section of ROOT_HELP_SECTIONS) {
    out.push(chalk.bold(`${section.title}:`));
    for (const name of section.commands) {
      const line = lines.get(name);
      // The manifest test holds every section name to a help line; this only
      // keeps a mistake from printing "undefined" before CI catches it.
      if (line) out.push(`  ${line.usage.padEnd(USAGE_WIDTH)}${line.summary}`);
    }
    out.push(``);
  }
  return out.join("\n");
}

/**
 * The commands `register/oss-fallbacks.ts` registers when Ix Pro is absent.
 * With Pro loaded, its own `note` and `session` are listed in its section.
 */
const OSS_MEMORY_HELP = [
  chalk.bold(`Memory:`),
  `  note [text]           Record a note (ls, show, supersede, retract)`,
  `  session [actor]       List and manage sessions`,
].join("\n");

const FOOTER = `Use "ix <command> --help" for details.
`;

export function buildHelpText(
  proCommands?: { name: string; desc: string }[],
): string {
  let text = ossHelp();

  // No list means Pro did not load, so the OSS fallbacks are what answer.
  if (proCommands === undefined) text += `\n${OSS_MEMORY_HELP}\n\n`;

  if (proCommands && proCommands.length > 0) {
    text += "\nPro:\n";
    for (const { name, desc } of proCommands) {
      text += `  ${name.padEnd(20)}${desc}\n`;
    }
    text += "\n";
  }

  text += FOOTER;
  return text;
}
