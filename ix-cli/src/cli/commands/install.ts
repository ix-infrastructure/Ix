// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

interface InstallCommandOptions {
  dryRun: boolean;
  force: boolean;
  json: boolean;
  yes: boolean;
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description("Install the Ix skill into this machine's agent harnesses (a menu on a terminal)")
    .argument(
      "[harness-ids...]",
      "Only these harnesses (the ids `bash scripts/install-skill.sh --help` lists)",
    )
    .option("--dry-run", "Show what would be written, write nothing", false)
    .option("--force", "Overwrite a same-name skill that is not the Ix skill", false)
    .option(
      "--json",
      "Print the installer's per-host JSON report on stdout (prompts stay on stderr)",
      false,
    )
    .option("-y, --yes", "Skip the menu and apply now (needed off a terminal)", false)
    .addHelpText(
      "after",
      [
        "",
        "On a terminal this opens a menu: which harnesses, dry run or apply, and whether",
        "to overwrite a foreign skill named ix. The options above pre-fill it. Nothing is",
        "written until you confirm. Off a terminal there is no menu: --dry-run and --yes",
        "run bash scripts/install-skill.sh with the same options, and anything else",
        "prints a hint and writes nothing.",
        "",
        "Needs an Ix source checkout (the skill and its installer ship with the repo).",
        "MCP registration stays in `ix mcp install`.",
      ].join("\n"),
    )
    .action(async (ids: string[], opts: InstallCommandOptions) => {
      const menu = await import("../install-menu.js");
      const script = menu.locateSkillInstaller();
      if (!script) {
        process.stderr.write(
          "error: ix install needs an Ix source checkout. scripts/install-skill.sh and skills/ix ship\n" +
            "       with the repository, not with this CLI build. From a clone, run:\n" +
            "         bash scripts/install-skill.sh --dry-run\n",
        );
        process.exitCode = 1;
        return;
      }
      const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !opts.yes;
      const terminal = interactive ? menu.terminalAsk() : null;
      try {
        const { renderBanner } = await import("../banner.js");
        process.exitCode = await menu.runInstallMenu(
          { ids, dryRun: opts.dryRun, force: opts.force, json: opts.json, yes: opts.yes },
          {
            engine: menu.createSkillEngine(script),
            interactive,
            ask: terminal ? terminal.ask : async () => null,
            out: (text) => process.stdout.write(text),
            err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
            banner: renderBanner,
          },
        );
      } finally {
        terminal?.close();
      }
    });
}
