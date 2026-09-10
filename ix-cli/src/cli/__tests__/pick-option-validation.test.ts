// Copyright 2026 Ix Infrastructure INC

import { Command, type CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { parsePickOption } from "../options.js";
import { registerOssCommands } from "../register/oss.js";

const PICK_COMMANDS: Array<[string, string[]]> = [
  ["callers", ["callers", "Widget"]],
  ["callees", ["callees", "Widget"]],
  ["contains", ["contains", "Widget"]],
  ["context", ["context", "Widget"]],
  ["depends", ["depends", "Widget"]],
  ["diff", ["diff", "1", "2", "Widget"]],
  ["explain", ["explain", "Widget"]],
  ["history", ["history", "Widget"]],
  ["impact", ["impact", "Widget"]],
  ["imported-by", ["imported-by", "Widget"]],
  ["imports", ["imports", "Widget"]],
  ["locate", ["locate", "Widget"]],
  ["overview", ["overview", "Widget"]],
  ["read", ["read", "Widget"]],
  ["subsystems", ["subsystems", "Widget"]],
  ["trace", ["trace", "Widget"]],
];

async function rejectPick(args: string[], pick: string): Promise<{ error?: CommanderError; stderr: string }> {
  const stderr: string[] = [];
  const program = new Command()
    .name("ix")
    .exitOverride()
    .configureOutput({ writeErr: (chunk) => stderr.push(chunk) });
  registerOssCommands(program);

  try {
    await program.parseAsync([...args, "--pick", pick], { from: "user" });
    return { stderr: stderr.join("") };
  } catch (error) {
    return { error: error as CommanderError, stderr: stderr.join("") };
  }
}

describe("shared --pick validation", () => {
  it.each(PICK_COMMANDS)("rejects a partial integer before running %s", async (_name, args) => {
    const result = await rejectPick(args, "1nope");

    expect(result.error?.exitCode).toBe(1);
    expect(result.stderr).toContain("must be a positive integer");
    expect(result.stderr).not.toContain("TypeError");
  });

  it.each(["nope", "0", "-1", "9007199254740992"])("rejects %j", (value) => {
    expect(() => parsePickOption(value)).toThrow("must be a positive integer");
  });

  it.each([
    ["1", 1],
    ["+2", 2],
  ])("parses %s", (value, expected) => {
    expect(parsePickOption(value)).toBe(expected);
  });
});
