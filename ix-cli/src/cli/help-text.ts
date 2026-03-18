const HEADER = [
  "Ix",
  "Understand any system, instantly.",
  "Your virtual cartographer.",
].join("\n");

const OSS_HELP = `${HEADER}

Core:
  init                  Start mapping this project
  search <term>         Find anything
  locate <symbol>       Jump to definition
  explain <symbol>      What it does
  impact <target>       Whats affected
  overview <target>     Where it fits
  watch                 Stay in sync

Utilities:
  read <target>         View source
  inventory             Explore structure
  rank                  What matters most
  history <entityId>    What changed
  diff <from> <to>      Compare changes

System:
  ingest [path]         Add code
  status                System status
  stats                 System stats
  doctor                Diagnose issues
  docker <action>       Manage services
`;

const FOOTER = `Advanced: ix help advanced
Use "ix <command> --help" for details on any command.
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
