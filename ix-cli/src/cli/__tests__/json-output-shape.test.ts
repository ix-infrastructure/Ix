// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { printJson, setPrettyJson } from "../format.js";
import { registerOssCommands } from "../register/oss.js";

const payload = { name: "resolveWorkspaceRoot", path: "src/cli/config.ts", lines: [322, 342] };

function withTty<T>(isTTY: boolean | undefined, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

function captured(fn: () => void): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => setPrettyJson(false));

describe("printJson", () => {
  it("is compact when stdout is not a terminal", () => {
    const out = withTty(undefined, () => captured(() => printJson(payload)));
    expect(out).toBe(JSON.stringify(payload));
    expect(out).not.toContain("\n");
  });

  it("indents when a person is watching", () => {
    const out = withTty(true, () => captured(() => printJson(payload)));
    expect(out).toBe(JSON.stringify(payload, null, 2));
  });

  it("indents off-TTY once --pretty has been recorded", () => {
    setPrettyJson(true);
    const out = withTty(undefined, () => captured(() => printJson(payload)));
    expect(out).toBe(JSON.stringify(payload, null, 2));
  });

  it("re-reads the destination on every call", () => {
    // The shape is a property of where the bytes are going, not of where the
    // process was when this module loaded.
    const piped = withTty(undefined, () => captured(() => printJson(payload)));
    const terminal = withTty(true, () => captured(() => printJson(payload)));
    expect(piped).not.toBe(terminal);
  });
});

describe("--pretty", () => {
  it("is offered by every command that can emit JSON", () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);

    const pending = [...program.commands];
    const missing: string[] = [];
    while (pending.length > 0) {
      const command = pending.shift()!;
      pending.push(...command.commands);
      const format = command.options.find((option) => option.long === "--format");
      if (!format?.argChoices?.includes("json")) continue;
      if (!command.options.some((option) => option.long === "--pretty")) missing.push(command.name());
    }
    expect(missing).toEqual([]);
  });

  it("is not offered by commands with no JSON to shape", () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);

    const upgrade = program.commands.find((command) => command.name() === "upgrade");
    expect(upgrade?.options.some((option) => option.long === "--pretty")).toBe(false);
  });

  it("reaches the renderers through the root preAction hook", async () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerOssCommands(program);
    program
      .command("probe")
      .option("--pretty")
      .action(() => {});

    await program.parseAsync(["probe", "--pretty"], { from: "user" });
    const out = withTty(undefined, () => captured(() => printJson(payload)));
    expect(out).toBe(JSON.stringify(payload, null, 2));

    await program.parseAsync(["probe"], { from: "user" });
    const plain = withTty(undefined, () => captured(() => printJson(payload)));
    expect(plain).toBe(JSON.stringify(payload));
  });
});
