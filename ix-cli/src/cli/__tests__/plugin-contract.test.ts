// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

const { textInvocations, jsonInvocations, check } = await import(
  new URL("../../../scripts/check-plugin-contract.mjs", import.meta.url).href
);

const surface = new Map([
  ["map", { flags: new Set(["--remap", "--silent"]), subcommands: new Set() }],
]);

describe("plugin contract inline commands", () => {
  it.each([
    ["Markdown", "Run `ix map --remap` to refresh."],
    ["TypeScript template string", "const prompt = `Run \\`ix map --remap\\` to refresh.`;"],
    ["multiple flags", "const prompt = `Run \\`ix map --silent --remap\\`.`;"],
    ["fenced block", "```sh\nix map --remap\n```"],
  ])("accepts registered flags in %s", (_kind, text) => {
    const invocations = textInvocations(text);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].argv.at(-1)).toBe("--remap");
    expect(check(invocations[0].argv, surface)).toBeNull();
  });

  it("checks decoded JSON prompts through the same scanner", () => {
    const invocations = jsonInvocations(JSON.stringify({ prompt: "Run `ix map --remap`." }));
    expect(invocations).toHaveLength(1);
    expect(check(invocations[0].argv, surface)).toBeNull();
  });

  it("preserves diagnostics for mixed escaped and plain spans", () => {
    const invocations = textInvocations([
      "Instructions:",
      "const prompt = `Run \\`ix map --remap\\`.`;",
      "Then run `ix map --missing`.",
    ].join("\n"));
    expect(invocations).toEqual([
      { argv: ["map", "--remap"], line: 2, snippet: "ix map --remap" },
      { argv: ["map", "--missing"], line: 3, snippet: "ix map --missing" },
    ]);
    expect(invocations.map(({ argv }: { argv: string[] }) => check(argv, surface))).toEqual([
      null,
      '"map" has no --missing',
    ]);
  });

  it.each([
    "Run `ix map --missing`.",
    "const prompt = `Run \\`ix map --missing\\`.`;",
    "```sh\nix map --missing\n```",
  ])("still rejects unknown flags: %s", (text) => {
    const invocations = textInvocations(text);
    expect(invocations).toHaveLength(1);
    expect(check(invocations[0].argv, surface)).toBe('"map" has no --missing');
  });
});
