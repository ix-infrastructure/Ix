// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

/**
 * The plugin contract check (ix-cli/scripts/check-plugin-contract.mjs) reads
 * the CLI surface from a build, so these tests hand `check` a small surface of
 * their own and pin only the parsing: which flag a plugin's text names.
 */
type Surface = Map<string, { flags: Set<string>; subcommands: Set<string> }>;
type Invocation = { argv: string[]; line: number; snippet: string };

// @ts-expect-error — no .d.mts: the local interface below is the type contract.
const contract = (await import("../../../scripts/check-plugin-contract.mjs")) as unknown as {
  textInvocations: (text: string) => Invocation[];
  check: (argv: string[], surface: Surface) => string | null;
};

const surface: Surface = new Map([
  ["map", { flags: new Set(["--remap", "--format"]), subcommands: new Set<string>() }],
  ["docker", { flags: new Set<string>(), subcommands: new Set(["start"]) }],
  ["docker start", { flags: new Set(["--port"]), subcommands: new Set<string>() }],
]);

/** The problems the checker reports for one source text. */
function problems(text: string): (string | null)[] {
  return contract.textInvocations(text).map((inv) => contract.check(inv.argv, surface));
}

describe("check-plugin-contract", () => {
  it("reads a flag inside an escaped-backtick template literal (ix-openclaw / ix-opencode)", () => {
    const openclaw = "      : `Map is stale. Run \\`ix map --remap\\` to refresh it now._`;";
    const opencode =
      "  return `_Map is out of date; run \\`ix map --remap\\` to refresh it now._`;";
    expect(problems(openclaw)).toEqual([null]);
    expect(problems(opencode)).toEqual([null]);
  });

  it.each([
    "--remap\\",
    "--remap`",
    "--remap.",
    "--remap,",
    "--remap)",
    '--remap"',
    "--remap'",
    "--remap=1",
  ])("counts %s as --remap", (flag) => {
    expect(contract.check(["map", flag], surface)).toBeNull();
  });

  it("still reports a misspelt flag, with or without trailing punctuation", () => {
    expect(contract.check(["map", "--remapp"], surface)).toBe('"map" has no --remapp');
    expect(contract.check(["map", "--remapp."], surface)).toBe('"map" has no --remapp');
    expect(problems("Then run `ix map --remapp` to refresh.")).toEqual(['"map" has no --remapp']);
  });

  it("reads a flag at the end of a sentence in a code span", () => {
    expect(problems("Run `ix map --format json --remap.` when stale.")).toEqual([null]);
  });

  it("reports a flag the CLI lacks under the full name the plugin wrote", () => {
    expect(contract.check(["map", "--re_map"], surface)).toBe('"map" has no --re_map');
    expect(contract.check(["map", "--remap_x."], surface)).toBe('"map" has no --remap_x');
  });

  it("reads a command span closed by an escaped backtick", () => {
    expect(problems("`Run \\`ix map\\` first.`")).toEqual([null]);
    expect(problems("`Run \\`ix mapp\\` first.`")).toEqual(['unknown command "mapp"']);
  });

  it("still skips prose whose first word ends in punctuation", () => {
    const prose = [
      "throw new Error(`\\`ix failed: ${msg}\\``);",
      "Reason: `ix unavailable.`",
      "Saw `ix exited, code 1` in the log.",
    ].join("\n");
    expect(problems(prose)).toEqual([null, null, null]);
    expect(contract.check(["docker", "start.", "--remap"], surface)).toBe('"docker" has no --remap');
  });
});
