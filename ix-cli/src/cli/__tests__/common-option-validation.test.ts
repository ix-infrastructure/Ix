import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerOssCommands } from "../register/oss.js";
import { validateCliOptions } from "../options.js";

async function parseInvalid(args: string[]): Promise<unknown> {
  const program = new Command();
  program.name("ix").exitOverride();
  registerOssCommands(program);
  try {
    await program.parseAsync(args, { from: "user" });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("common CLI option validation", () => {
  it("declares every documented enum as Commander choices", () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);
    const pending = [...program.commands];

    while (pending.length > 0) {
      const command = pending.shift()!;
      pending.push(...command.commands);
      for (const option of command.options) {
        const group = option.description.match(/\(([^()]*(?:\|)[^()]*)\)/)?.[1];
        if (!group) continue;
        expect(option.argChoices, `${command.name()} ${option.long}`).toEqual(
          group.split("|").map((choice) => choice.trim()),
        );
      }
    }
  });

  it("does not make a later Pro command's help text an implicit runtime contract", async () => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);
    let received: string | undefined;
    program
      .command("pro-test")
      .option("--mode <mode>", "Presentation mode (short|full)")
      .action((options: { mode?: string }) => { received = options.mode; });

    await program.parseAsync(["pro-test", "--mode", "custom"], { from: "user" });

    expect(received).toBe("custom");
  });

  // Same reasoning, one step further: the preAction hook lives on the root
  // program, so it fires for Pro commands too. The `<n>` rule is a claim about
  // option declarations in *this* repo -- a Pro flag that spells a float or a
  // negative `<n>` would be rejected by a rule its author never opted into.
  it("does not apply the numeric rules to a later Pro command's options", async () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerOssCommands(program);
    const received: Record<string, string | undefined> = {};
    program
      .command("pro-numeric")
      .option("--threshold <n>", "Similarity threshold")
      .option("--min-confidence <n>", "Confidence floor")
      .option("--as-of <rev>", "Revision")
      .action((options: { threshold?: string; minConfidence?: string; asOf?: string }) => {
        received.threshold = options.threshold;
        received.minConfidence = options.minConfidence;
        received.asOf = options.asOf;
      });

    await program.parseAsync(
      ["pro-numeric", "--threshold", "0.8", "--min-confidence", "7", "--as-of", "HEAD~2"],
      { from: "user" },
    );

    expect(received).toEqual({ threshold: "0.8", minConfidence: "7", asOf: "HEAD~2" });
  });

  it.each([
    [["doctor", "--format", "yaml"], "--format"],
    [["inventory", "--kind", "file", "--limit", "1e3"], "--limit"],
    [["rank", "--by", "dependents", "--kind", "class", "--top", "10abc"], "--top"],
    [["patches", "--limit", "-1"], "--limit"],
    [["search", "term", "--as-of", "abc"], "--as-of"],
    [["search", "term", "--as-of", "1e3"], "--as-of"],
    [["map", "--level", "nope"], "--level"],
    [["map", "--min-confidence", "1.1"], "--min-confidence"],
    [["map", "--sort", "newest"], "--sort"],
    [["savings", "--model", "unknown"], "--model"],
  ] as const)("rejects %j before running the command", async (args, option) => {
    const error = await parseInvalid([...args]);

    expect(error).toMatchObject({ code: "commander.invalidArgument" });
    expect(String((error as Error).message)).toContain(option);
  });

  it.each([
    ["doctor", "--format", "json"],
    ["map", "--format", "silent"],
    ["map", "--min-confidence", "0.75"],
    ["subsystems", "--offset", "0"],
    // 0 is this flag's own default, so rejecting it was incoherent.
    ["smells", "--orphan-max-connections", "0"],
    ["smells", "--weak-max-neighbors", "0"],
  ] as const)("accepts the documented value in %j", (command, option, value) => {
    const program = new Command();
    program.name("ix");
    registerOssCommands(program);
    const action = program.commands.find((candidate) => candidate.name() === command)!;
    action.parseOptions([option, value]);

    expect(() => validateCliOptions(action)).not.toThrow();
  });

  // The regression this hook shipped with: it read every option's *default*
  // through `command.opts()`, so a command whose own default fell outside the
  // rule could not be run at all. `ix smells` defaults
  // --orphan-max-connections to "0" and died on `ix smells` with no arguments.
  it.each(["smells", "map", "subsystems", "rank", "inventory", "patches", "doctor", "status", "context"])(
    "runs %s on its defaults alone",
    (command) => {
      const program = new Command();
      program.name("ix");
      registerOssCommands(program);
      const action = program.commands.find((candidate) => candidate.name() === command)!;
      action.parseOptions([]);

      expect(() => validateCliOptions(action)).not.toThrow();
    },
  );
});
