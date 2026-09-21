// Copyright 2026 Ix Infrastructure Inc.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { resolveDefaultFormat } from "../default-format.js";
import { registerOssCommands } from "../register/oss.js";

const noConfig = () => undefined;

describe("resolveDefaultFormat", () => {
  it("falls back to text when nothing is configured", () => {
    expect(resolveDefaultFormat({}, noConfig)).toEqual({ format: "text" });
  });

  it("reads IX_FORMAT", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: "llm" }, noConfig)).toEqual({ format: "llm" });
  });

  it("reads config.format when IX_FORMAT is unset", () => {
    expect(resolveDefaultFormat({}, () => "json")).toEqual({ format: "json" });
  });

  it("lets IX_FORMAT outrank config.format", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: "llm" }, () => "json")).toEqual({ format: "llm" });
  });

  it("does not read config when IX_FORMAT already answered", () => {
    const readConfig = vi.fn(() => "json");
    resolveDefaultFormat({ IX_FORMAT: "llm" }, readConfig);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("accepts a padded or capitalised value", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: " LLM " }, noConfig).format).toBe("llm");
  });

  it("ignores an empty value rather than reporting it", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: "" }, () => "llm")).toEqual({ format: "llm" });
  });

  it("reports an unrecognised value and falls through to the next source", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: "yaml" }, () => "llm")).toEqual({
      format: "llm",
      ignored: { source: "IX_FORMAT", value: "yaml" },
    });
  });

  it("reports an unrecognised config value", () => {
    expect(resolveDefaultFormat({}, () => "pretty")).toEqual({
      format: "text",
      ignored: { source: "config.format", value: "pretty" },
    });
  });

  it("keeps the more specific of two unrecognised values", () => {
    expect(resolveDefaultFormat({ IX_FORMAT: "yaml" }, () => "pretty")).toEqual({
      format: "text",
      ignored: { source: "IX_FORMAT", value: "yaml" },
    });
  });
});

/**
 * The registrar is exercised through a real program because what matters is
 * commander's resolution order: an explicit flag has to keep winning, and a
 * command that does not offer the configured format has to keep its own.
 */
describe("the default a command ends up with", () => {
  // An empty IX_HOME of its own, so the developer's real ~/.ix/config.yaml
  // cannot decide what these assert. The env is read when the commands are
  // registered, which is why each case re-registers rather than sharing one
  // program.
  const withEnv = async (env: Record<string, string>, argv: string[]) => {
    const home = mkdtempSync(join(tmpdir(), "ix-format-"));
    writeFileSync(join(home, "config.yaml"), "endpoint: http://localhost:8090\n");
    const previous = { ...process.env };
    Object.assign(process.env, { IX_HOME: home, ...env });
    try {
      const program = new Command();
      let seen: string | undefined;
      registerOssCommands(program);
      const command = program.commands.find((c) => c.name() === argv[0])!;
      command.action(function (this: Command) { seen = this.opts().format; });
      await program.parseAsync(argv, { from: "user" });
      return seen;
    } finally {
      for (const key of Object.keys({ IX_HOME: home, ...env })) delete process.env[key];
      Object.assign(process.env, previous);
    }
  };

  it("is text when nothing is set", async () => {
    expect(await withEnv({}, ["search", "Widget"])).toBe("text");
  });

  it("is IX_FORMAT when it is set", async () => {
    expect(await withEnv({ IX_FORMAT: "llm" }, ["search", "Widget"])).toBe("llm");
  });

  it("is still the flag when one is given", async () => {
    expect(await withEnv({ IX_FORMAT: "llm" }, ["search", "Widget", "--format", "json"])).toBe("json");
  });

  it("stays text for a command that does not render llm", async () => {
    // `query` offers text and json only.
    expect(await withEnv({ IX_FORMAT: "llm" }, ["query", "who calls Widget"])).toBe("text");
  });

  it("ignores a value that is not a format", async () => {
    expect(await withEnv({ IX_FORMAT: "yaml" }, ["search", "Widget"])).toBe("text");
  });
});
