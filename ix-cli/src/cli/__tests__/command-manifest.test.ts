// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { OSS_COMMANDS, ROOT_HELP_SECTIONS } from "../register/commands.js";
import { OSS_COMMAND_TABLE } from "../register/oss-table.js";
import { registerOssCommands } from "../register/oss.js";
import { applyOssSetup } from "../register/oss-setup.js";
import { buildHelpText } from "../help-text.js";
import { choiceOption } from "../options.js";

/**
 * `register/commands.ts` is the one list of OSS commands. The fast-path table,
 * `registerOssCommands()` and the root help are built from it, so these tests
 * check the generator and the manifest's own consistency rather than three
 * hand-kept lists against each other.
 */

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const names = OSS_COMMANDS.flatMap((entry) => entry.names);

describe("the command manifest", () => {
  it("names each command once", () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it("is what OSS_COMMAND_TABLE is keyed by, each name pointing at its entry's loader", () => {
    expect(Object.keys(OSS_COMMAND_TABLE)).toEqual(names);
    for (const entry of OSS_COMMANDS) {
      for (const name of entry.names) expect(OSS_COMMAND_TABLE[name], name).toBe(entry.load);
    }
  });

  it("is the order registerOssCommands() registers in, and the names it registers", () => {
    const program = new Command();
    registerOssCommands(program);
    // Each entry's first name is its module's first command. An extension
    // package registers after these and collisions go to the first, so the
    // order is part of the contract, not a detail.
    const firsts = OSS_COMMANDS.map((entry) => entry.names[0]);
    expect(program.commands.map((c) => c.name()).filter((n) => firsts.includes(n))).toEqual(firsts);
    expect(program.commands.flatMap((c) => [c.name(), ...c.aliases()]).sort()).toEqual([...names].sort());
  });

  it("places every help line in exactly one root-help section, and nothing else", () => {
    const lines = OSS_COMMANDS.flatMap((entry) => entry.help ?? []);
    const placed = ROOT_HELP_SECTIONS.flatMap((section) => section.commands);
    const lineNames = lines.map((line) => line.usage.split(" ")[0]);
    expect([...placed].sort()).toEqual([...lineNames].sort());
    expect(new Set(placed).size).toBe(placed.length);
    // A help line names a command its entry registers.
    for (const entry of OSS_COMMANDS) {
      for (const line of entry.help ?? []) expect(entry.names, line.usage).toContain(line.usage.split(" ")[0]);
    }
  });

  it("marks a command with no help line as unlisted on purpose", () => {
    const unlisted = OSS_COMMANDS.filter((entry) => entry.help === undefined).map((entry) => entry.names[0]);
    expect(unlisted).toEqual(["query", "init", "help", "hook"]);
  });
});

describe("the root help built from the manifest", () => {
  // Byte for byte what the hand-written `OSS_HELP` printed before the manifest.
  const EXPECTED_OSS_HELP = `ix — System Intelligence CLI

Start:
  map [path]            Map system
  watch                 Watch changes
  ingest [path]         Ingest files or GitHub data
  config                Update config

Understand:
  context [target]      Bounded context bundle (start here)
  search <term>         Search system
  text <term>           Search text (ripgrep)
  locate <symbol>       Find definition
  explain <symbol>      Explain behavior
  impact <target>       Analyze impact
  overview <target>     Summarize structure
  read <target>         Read source
  around <path:line>    Who depends on it
  smells                Detect issues

Explore:
  callers <symbol>      Who calls it
  callees <symbol>      What it calls
  overrides <symbol>    Its overrides and bases
  imports <target>      What it imports
  imported-by <target>  What imports it
  contains <target>     Its members
  depends <target>      Upstream dependents
  entity <id>           Entity details
  trace <symbol>        Trace flow
  subsystems            Explore structure
  inventory             List components
  rank                  Rank importance
  history <target>      Show history
  diff <from> <to>      Compare changes
  patches               Recent patches
  conflicts             Detected conflicts

System:
  status                Check status
  stats                 Show stats
  doctor                Diagnose issues
  verify                Compare graph to a re-parse
  mcp [install|doctor]  Serve agent tools over MCP
  install               Install the Ix skill into agent harnesses
  docker <action>       Manage backend
  view                  Open visualizer
  reset                 Reset map
  savings               Show token savings
  upgrade               Update ix
`;

  const MEMORY = `
Memory:
  note [text]           Record a note (ls, show, supersede, retract)
  session [actor]       List and manage sessions

`;

  const FOOTER = `Use "ix <command> --help" for details.\n`;

  it("prints the same OSS help as before, with Pro absent", () => {
    expect(stripAnsi(buildHelpText())).toBe(EXPECTED_OSS_HELP + MEMORY + FOOTER);
  });

  it("prints the same help with Pro loaded, with and without Pro commands", () => {
    expect(stripAnsi(buildHelpText([]))).toBe(EXPECTED_OSS_HELP + FOOTER);
    expect(stripAnsi(buildHelpText([{ name: "plan", desc: "Manage plans" }])))
      .toBe(`${EXPECTED_OSS_HELP}\nPro:\n  plan                Manage plans\n\n${FOOTER}`);
  });
});

describe("choiceOption", () => {
  function program(): Command {
    const root = new Command();
    root.command("pick")
      .addOption(choiceOption("--mode <mode>", "Mode (a|b)", ["a", "b"], "a"))
      .action(() => {});
    return root;
  }

  it("declares the option with its default, and leaves the choices to the OSS setup", () => {
    const root = program();
    const option = root.commands[0].options[0];
    expect(option.defaultValue).toBe("a");
    expect(option.argChoices).toBeUndefined();
    applyOssSetup(root);
    expect(option.argChoices).toEqual(["a", "b"]);
  });

  it("is enforced once the OSS setup has run", async () => {
    const root = program().exitOverride();
    root.commands[0].exitOverride().configureOutput({ writeErr: () => {} });
    applyOssSetup(root);
    await expect(root.parseAsync(["node", "ix", "pick", "--mode", "c"])).rejects.toThrow(/Allowed choices are a, b/);
  });
});
