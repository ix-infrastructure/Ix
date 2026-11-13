// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";

import { registerOssCommands, registerProStubs } from "../register/oss.js";
import { registerWorkflowsHelpCommand } from "../commands/workflows.js";
import {
  PRO_COMMANDS,
  PRO_COMMAND_NAMES,
  PRO_MCP_TOOL_NAMES,
  PRO_RETIRED,
  isProStub,
  proCommandsRegistered,
} from "../register/pro-surface.js";
import { IX_MCP_OSS_TOOL_NAMES, IX_MCP_PRO_TOOL_NAMES } from "../../mcp/server.js";

/**
 * #932: the Pro command surface is one table (register/pro-surface.ts). These
 * tests hold everything else — stubs, help, MCP, docs — to it.
 */

const repoRoot = path.resolve(__dirname, "../../../..");

function capture(fn: () => void): { stdout: string; stderr: string; exitCode: number | string | undefined } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  let code: number | string | undefined;
  try {
    fn();
  } catch (e) {
    stderr.push(String((e as Error).message));
  } finally {
    code = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    process.exitCode = origExit;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode: code };
}

/** Backticked names on the doc line that starts with `marker`, up to the next blank line. */
function docList(file: string, marker: string): string[] {
  const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const start = text.indexOf(marker);
  expect(start, `${file} has no "${marker}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  const paragraph = text.slice(start, end < 0 ? undefined : end);
  // Stop before the sentinel quote (`The '<name>' command ...`).
  const names = paragraph.split("Without Pro")[0].match(/`([a-z][a-z-]*)`/g) ?? [];
  return names.map((n) => n.slice(1, -1));
}

describe("Pro surface table", () => {
  it("has unique names, and no retired name is still current", () => {
    expect(new Set(PRO_COMMAND_NAMES).size).toBe(PRO_COMMAND_NAMES.length);
    for (const old of Object.keys(PRO_RETIRED)) expect(PRO_COMMAND_NAMES).not.toContain(old);
  });

  it("points every retired name at a current Pro command", () => {
    for (const [old, now] of Object.entries(PRO_RETIRED)) {
      expect(PRO_COMMAND_NAMES, `${old} -> ${now}`).toContain(now.split(" ")[0]);
    }
  });

  // #371: a Pro name that ix-cli also implements shadows the real command.
  it("names no command the OSS CLI registers", () => {
    const program = new Command();
    registerOssCommands(program);
    const oss = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
    for (const name of [...PRO_COMMAND_NAMES, ...Object.keys(PRO_RETIRED)]) {
      expect(oss.has(name), name).toBe(false);
    }
  });
});

describe("Pro stubs follow the table", () => {
  it("stubs every current Pro command and every retired name, and nothing else", () => {
    const program = new Command();
    registerProStubs(program);
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([...PRO_COMMAND_NAMES, ...Object.keys(PRO_RETIRED)].sort());
    expect(program.commands.every(isProStub)).toBe(true);
    for (const { name, description } of PRO_COMMANDS) {
      expect(program.commands.find((c) => c.name() === name)?.description()).toBe(description);
    }
  });

  it("a retired name names its replacement and still prints the Pro sentinel", () => {
    for (const [old, now] of Object.entries(PRO_RETIRED)) {
      const program = new Command();
      program.name("ix").exitOverride();
      registerProStubs(program);
      const { stderr, exitCode } = capture(() => program.parse(["node", "ix", old, "--status", "open"]));
      expect(stderr).toContain(`The '${now.split(" ")[0]}' command requires Ix Pro.`);
      expect(stderr).toContain(`'ix ${old}' is now 'ix ${now}'.`);
      expect(stderr).not.toContain(`The '${old}' command`);
      expect(exitCode).toBe(1);
    }
  });

  it("proCommandsRegistered is false for stubs and true for a real registration", () => {
    const stubbed = new Command();
    registerProStubs(stubbed);
    expect(proCommandsRegistered(stubbed)).toBe(false);

    const pro = new Command();
    pro.command("plan").description("real Pro plan");
    registerProStubs(pro); // skips the name Pro already registered
    expect(proCommandsRegistered(pro)).toBe(true);
  });
});

describe("ix help workflows says the commands need Ix Pro", () => {
  function helpWorkflows(withPro: boolean): string {
    const program = new Command();
    program.name("ix").exitOverride();
    if (withPro) for (const { name } of PRO_COMMANDS) program.command(name);
    registerWorkflowsHelpCommand(program);
    registerProStubs(program);
    return capture(() => program.parse(["node", "ix", "help", "workflows"])).stdout;
  }

  it("prints a note naming the Pro commands when Pro is not installed", () => {
    const out = helpWorkflows(false);
    expect(out).toMatch(/need Ix Pro, which is not installed/);
    const note = out.split("\n").find((l) => l.includes("need Ix Pro")) ?? "";
    // Every Pro command the text recommends is named in the note.
    for (const name of ["briefing", "plan", "workflow", "bug", "decide", "tasks"]) {
      expect(note).toContain(`ix ${name}`);
    }
    expect(note).not.toContain("ix overview");
  });

  it("prints no note when Pro registered its commands", () => {
    expect(helpWorkflows(true)).not.toContain("need Ix Pro");
  });

  it("forwards each retired plural topic to its replacement's help", () => {
    for (const [old, now] of Object.entries(PRO_RETIRED)) {
      const program = new Command();
      program.name("ix").exitOverride();
      registerProStubs(program);
      registerWorkflowsHelpCommand(program);
      const { stdout } = capture(() => program.parse(["node", "ix", "help", old]));
      expect(stdout).toMatch(new RegExp(`^Usage: ix ${now.split(" ")[0]}\\b`, "m"));
    }
  });
});

describe("MCP Pro tools follow the table", () => {
  it("IX_MCP_PRO_TOOL_NAMES is the table's MCP column", () => {
    expect([...IX_MCP_PRO_TOOL_NAMES]).toEqual([...PRO_MCP_TOOL_NAMES]);
    for (const tool of PRO_MCP_TOOL_NAMES) expect(IX_MCP_OSS_TOOL_NAMES as readonly string[]).not.toContain(tool);
  });
});

describe("docs list exactly the current Pro commands", () => {
  it.each([
    ["skills/ix/references/output-formats.md", "Pro-only surface:"],
    ["docs-site/src/content/docs/reference/commands.md", "Some commands ("],
  ])("%s", (file, marker) => {
    expect(docList(file, marker).sort()).toEqual([...PRO_COMMAND_NAMES].sort());
  });
});
