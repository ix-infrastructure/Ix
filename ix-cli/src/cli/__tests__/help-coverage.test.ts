// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { buildHelpText } from "../help-text.js";
import { registerOssCommands } from "../register/oss.js";

/**
 * Verify that buildHelpText output mentions all core commands.
 * This prevents regression where new commands become invisible.
 */

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const ossHelp = buildHelpText();

const REQUIRED_COMMANDS = [
  "search", "locate", "explain", "impact", "overview", "watch",
  "read", "inventory", "rank", "history", "diff", "smells", "subsystems",
  "map", "trace", "status", "stats", "doctor", "docker",
  "mcp",
];

describe("help coverage", () => {
  it("OSS help is non-empty", () => {
    expect(ossHelp.length).toBeGreaterThan(100);
  });

  it("OSS help mentions all core commands", () => {
    const missing: string[] = [];
    for (const cmd of REQUIRED_COMMANDS) {
      if (!ossHelp.includes(cmd)) {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });

  it("OSS help uses new branding", () => {
    expect(stripAnsi(ossHelp)).toContain("ix — System Intelligence CLI");
    expect(stripAnsi(ossHelp)).not.toContain("Persistent Memory for LLM Systems");
  });

  it("OSS help does not show a Pro section", () => {
    expect(ossHelp).not.toContain("Pro:");
  });

  it("Pro help includes Pro section when commands provided", () => {
    const proHelp = buildHelpText([
      { name: "plan", desc: "Manage plans" },
      { name: "goal", desc: "Manage goals" },
    ]);
    expect(proHelp).toContain("Pro:");
    expect(proHelp).toContain("plan");
    expect(proHelp).toContain("Manage plans");
    expect(proHelp).toContain("goal");
  });
});

/**
 * `ix --help` is a hand-written list, so a new command was easy to leave out:
 * `context`, the command agents are told to use first, was missing. Every
 * command the OSS build registers and does not hide has to be in it.
 */
/** Registered but deliberately not listed: deprecated, or not a command people run. */
const UNLISTED = new Set(["query", "init", "help", "hook"]);

describe("help coverage against the registrations", () => {
  it("lists every non-hidden OSS command", () => {
    const program = new Command();
    registerOssCommands(program);
    const help = buildHelpText();
    const listed = (name: string) => new RegExp(`^\\s{2}${name}\\b`, "m").test(help);
    const visible = program.commands
      .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
      .map((c) => c.name())
      .filter((name) => !UNLISTED.has(name));
    expect(visible.length).toBeGreaterThan(20);
    expect(visible.filter((name) => !listed(name))).toEqual([]);
  });
});

describe("help argument shapes match the registrations", () => {
  it("marks an argument optional in the help exactly when the command does", () => {
    const program = new Command();
    registerOssCommands(program);
    const wrong: string[] = [];
    for (const line of buildHelpText().split("\n")) {
      const match = /^\s{2}(\S+)((?:\s+[<[][^\s>\]]+[>\]])*)/.exec(line);
      if (!match) continue;
      const command = program.commands.find((c) => c.name() === match[1]);
      // Commands with subcommands show the subcommand in the slot (`docker <action>`).
      if (!command || command.commands.length > 0) continue;
      const shown = match[2].trim().split(/\s+/).filter(Boolean);
      shown.forEach((token, i) => {
        const registered = command.registeredArguments[i];
        if (!registered || registered.required !== token.startsWith("<")) {
          wrong.push(`${match[1]} ${token}`);
        }
      });
    }
    expect(wrong).toEqual([]);
  });
});
