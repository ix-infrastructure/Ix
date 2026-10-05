// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";

const OSS_HELP = [
  `${chalk.cyan("ix")} — System Intelligence CLI`,
  ``,
  chalk.bold(`Start:`),
  `  map [path]            Map system`,
  `  watch                 Watch changes`,
  `  ingest [path]         Ingest files or GitHub data`,
  `  config                Update config`,
  ``,
  chalk.bold(`Understand:`),
  `  context [target]      Bounded context bundle (start here)`,
  `  search <term>         Search system`,
  `  text <term>           Search text (ripgrep)`,
  `  locate <symbol>       Find definition`,
  `  explain <symbol>      Explain behavior`,
  `  impact <target>       Analyze impact`,
  `  overview <target>     Summarize structure`,
  `  read <target>         Read source`,
  `  around <path:line>    Who depends on it`,
  `  smells                Detect issues`,
  ``,
  chalk.bold(`Explore:`),
  `  callers <symbol>      Who calls it`,
  `  callees <symbol>      What it calls`,
  `  imports <target>      What it imports`,
  `  imported-by <target>  What imports it`,
  `  contains <target>     Its members`,
  `  depends <target>      Upstream dependents`,
  `  entity <id>           Entity details`,
  `  trace <symbol>        Trace flow`,
  `  subsystems            Explore structure`,
  `  inventory             List components`,
  `  rank                  Rank importance`,
  `  history <target>      Show history`,
  `  diff <from> <to>      Compare changes`,
  `  patches               Recent patches`,
  `  conflicts             Detected conflicts`,
  ``,
  chalk.bold(`System:`),
  `  status                Check status`,
  `  stats                 Show stats`,
  `  doctor                Diagnose issues`,
  `  mcp [install|doctor]  Serve agent tools over MCP`,
  `  docker <action>       Manage backend`,
  `  view                  Open visualizer`,
  `  reset                 Reset map`,
  `  savings               Show token savings`,
  `  upgrade               Update ix`,
  ``,
].join("\n");

const FOOTER = `Use "ix <command> --help" for details.
`;

export function buildHelpText(
  proCommands?: { name: string; desc: string }[],
): string {
  let text = OSS_HELP;

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
