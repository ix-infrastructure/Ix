// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { check, jsonInvocations, textInvocations } from "./check-plugin-contract.mjs";

const surface = new Map([
  ["map", { flags: new Set(["--remap", "--silent"]), subcommands: new Set() }],
]);

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

  it("preserves JSON prompt decoding, paths and line numbers", () => {
    const invocations = jsonInvocations(JSON.stringify({ agent: { prompt: "Instructions:\n`ix map --remap`" } }));
    expect(invocations).toMatchObject([{ argv: ["map", "--remap"], line: "agent.prompt:2" }]);
    expect(check(invocations[0].argv, surface)).toBeNull();
  });
});
