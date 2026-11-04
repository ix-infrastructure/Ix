// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { check, invocationLocation, jsonInvocations, textInvocations } from "./check-plugin-contract.mjs";

const surface = new Map([
  ["map", { flags: new Set(["--remap", "--silent"]), subcommands: new Set() }],
]);

describe("plugin contract ignores", () => {
  it.each([posix, win32])("uses slash-delimited locations for native relative paths", (paths) => {
    const root = paths.resolve("plugins", "ix-codex-plugin");
    const file = paths.join(root, "tests", "test_lookup_exit_codes.py");
    expect(invocationLocation("ix-codex-plugin", paths.relative(root, file), 1)).toBe(
      "ix-codex-plugin/tests/test_lookup_exit_codes.py:1",
    );
  });

  it("ignores the parameterized lookup fixture while still rejecting real contract violations", () => {
    const root = mkdtempSync(fileURLToPath(new URL("../.plugin-contract-test-", import.meta.url)));
    try {
      for (const name of ["check-plugin-contract.mjs", "plugin-contract-ignore.json"]) {
        copyFileSync(new URL(name, import.meta.url), join(root, name));
      }
      // Exercise the script and its real ignore list without a CLI build or network access.
      writeFileSync(join(root, "dump-cli-surface.mjs"), 'console.log(JSON.stringify([{ command: "ix map", options: [{ long: "--remap" }] }]));');
      const plugins = join(root, "plugins");
      for (const name of ["claude", "codex", "cursor", "gemini", "openclaw", "opencode"]) {
        mkdirSync(join(plugins, `ix-${name}-plugin`, "tests"), { recursive: true });
      }
      const fixture = join(plugins, "ix-codex-plugin", "tests", "test_lookup_exit_codes.py");
      const source = 'common.run_ix_lookup(["ix", command, "x", "--format", "json"])\n';
      const run = () => spawnSync(process.execPath, [join(root, "check-plugin-contract.mjs"), plugins], { encoding: "utf8" });
      writeFileSync(fixture, source);
      const ignored = run();
      expect(ignored.status, ignored.stderr).toBe(0);
      expect(ignored.stdout).toContain("checked 1 ix invocations in 6 plugins");

      writeFileSync(fixture, source + 'common.run_ix_lookup(["ix", "x", "--format", "json"])\ncommon.run_ix_lookup(["ix", "map", "--missing"])\n');
      const invalid = run();
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('test_lookup_exit_codes.py:2  unknown command "x"');
      expect(invalid.stderr).toContain('test_lookup_exit_codes.py:3  "map" has no --missing');

      writeFileSync(fixture, source);
      writeFileSync(join(plugins, "ix-codex-plugin", "tests", "other.py"), source);
      const elsewhere = run();
      expect(elsewhere.status).toBe(1);
      expect(elsewhere.stderr).toContain('other.py:1  unknown command "x"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("plugin prompt invocations", () => {
  it("recognizes escaped Markdown delimiters in raw TypeScript template strings", () => {
    const source = 'const prompt = `Instructions:\nRun \\`ix map --remap\\` before continuing.`;';
    const [invocation] = textInvocations(source);
    expect(invocation.argv).toEqual(["map", "--remap"]);
    expect(invocation.line).toBe(2);
    expect(check(invocation.argv, surface)).toBeNull();
  });

  it("still reports unknown flags inside escaped delimiters", () => {
    const [invocation] = textInvocations('const prompt = `Run \\`ix map --missing\\`.`;');
    expect(check(invocation.argv, surface)).toBe('"map" has no --missing');
  });

  it("recognizes escaped fenced commands in template prompts", () => {
    const fence = "\\`\\`\\`";
    const invocations = textInvocations(`Instructions:\r\n${fence}sh\r\nix map --remap\r\nix map --missing\r\n${fence}`);
    expect(invocations.map(inv => inv.argv)).toEqual([["map", "--remap"], ["map", "--missing"]]);
    expect(invocations.map(inv => inv.line)).toEqual([3, 4]);
    expect(check(invocations[0].argv, surface)).toBeNull();
    expect(check(invocations[1].argv, surface)).toBe('"map" has no --missing');
  });

  it("keeps ordinary Markdown spans and fenced commands", () => {
    const invocations = textInvocations("Run `ix map --remap`.\n```sh\nix map --silent\n```");
    expect(invocations.map(inv => inv.argv)).toEqual([["map", "--remap"], ["map", "--silent"]]);
    expect(invocations.map(inv => inv.line)).toEqual([1, 3]);
    expect(invocations.every(inv => check(inv.argv, surface) === null)).toBe(true);
  });

  it("checks trailing punctuation in escaped fenced prompts without hiding misspelt flags", () => {
    const fence = "\\`\\`\\`";
    const invocations = textInvocations(`${fence}sh\nix map --remap.\nix map --remapp.\n${fence}`);
    expect(invocations.map(inv => inv.line)).toEqual([2, 3]);
    expect(invocations.map(inv => check(inv.argv, surface))).toEqual([null, '"map" has no --remapp']);
  });

  it("preserves JSON prompt decoding, paths and line numbers", () => {
    const invocations = jsonInvocations(JSON.stringify({ agent: { prompt: "Instructions:\n`ix map --remap`" } }));
    expect(invocations).toMatchObject([{ argv: ["map", "--remap"], line: "agent.prompt:2" }]);
    expect(check(invocations[0].argv, surface)).toBeNull();
  });
});
