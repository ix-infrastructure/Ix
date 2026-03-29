import chalk from "chalk";

const OSS_HELP = [
  `${chalk.cyan("ix")} — System Intelligence CLI`,
  ``,
  chalk.bold(`Start:`),
  `  map [path]            Map system`,
  `  watch                 Watch changes`,
  `  config                Update config`,
  ``,
  chalk.bold(`Understand:`),
  `  search <term>         Search system`,
  `  locate <symbol>       Find definition`,
  `  explain <symbol>      Explain behavior`,
  `  impact <target>       Analyze impact`,
  `  overview <target>     Summarize structure`,
  `  read <target>         Read source`,
  `  smells                Detect issues`,
  ``,
  chalk.bold(`Explore:`),
  `  trace <symbol>        Trace flow`,
  `  subsystem             Explore structure`,
  `  inventory             List components`,
  `  rank                  Rank importance`,
  `  history <target>      Show history`,
  `  diff <from> <to>      Compare changes`,
  ``,
  chalk.bold(`System:`),
  `  status                Check status`,
  `  stats                 Show stats`,
  `  doctor                Diagnose issues`,
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
