import { Command, type CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFileOrEntity = vi.hoisted(() => vi.fn());

vi.mock("../resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve.js")>()),
  resolveFileOrEntity,
}));

import { parseContextDepthOption, registerContextCommand } from "../commands/context.js";

async function runContext(args: string[]): Promise<{ error?: CommanderError; stderr: string }> {
  const stderr: string[] = [];
  const program = new Command()
    .name("ix")
    .exitOverride()
    .configureOutput({ writeErr: (chunk) => stderr.push(chunk) });
  registerContextCommand(program);

  try {
    await program.parseAsync(["context", "Widget", ...args], { from: "user" });
    return { stderr: stderr.join("") };
  } catch (error) {
    return { error: error as CommanderError, stderr: stderr.join("") };
  }
}

describe("ix context --pick validation", () => {
  beforeEach(() => {
    resolveFileOrEntity.mockReset().mockResolvedValue(undefined);
  });

  it.each(["nope", "1nope"])("rejects the complete value %j before resolving", async (pick) => {
    const result = await runContext(["--pick", pick]);

    expect(result.error?.exitCode).toBe(1);
    expect(result.stderr).toContain("argument '" + pick + "' is invalid");
    expect(result.stderr).toContain("must be a positive integer");
    expect(result.stderr).not.toContain("TypeError");
    expect(resolveFileOrEntity).not.toHaveBeenCalled();
  });

  it.each([
    ["1", 1],
    ["2", 2],
  ])("passes valid pick %s to resolution as an integer", async (rawPick, expectedPick) => {
    const result = await runContext([
      "--pick",
      rawPick,
      "--kind",
      "function",
      "--path",
      "src/main.ts",
    ]);

    expect(result.error).toBeUndefined();
    expect(resolveFileOrEntity).toHaveBeenCalledOnce();
    expect(resolveFileOrEntity.mock.calls[0]?.[2]).toEqual({
      kind: "function",
      path: "src/main.ts",
      pick: expectedPick,
    });
  });
});

/**
 * The `--max-*` flags now validate at parse time too, for a sharper reason than
 * `--pick` does: `ix context --diff` reports the requested budget back to the
 * caller. Reading the raw option string back out with `Number.parseInt` — which
 * is what this replaces — is not a check. It reads `"10abc"` as 10, `"0x10"` as
 * 0, `"1e3"` as 1 and `"-5"` as -5, so `--max-entities 1e3` was reported as
 * `budgets scope=requested entities=1 applied=false`: a request the user never
 * made, on the one record whose whole purpose is saying what they asked for.
 */
describe("ix context --max-* validation", () => {
  beforeEach(() => {
    resolveFileOrEntity.mockReset().mockResolvedValue(undefined);
  });

  it.each(["10abc", "0x10", "1e3", "-5", "0", "3.5", "", "  "])(
    "rejects %j before building anything",
    async (value) => {
      const result = await runContext(["--max-entities", value]);

      expect(result.error?.exitCode).toBe(1);
      expect(result.stderr).toContain("must be a positive integer");
      expect(resolveFileOrEntity).not.toHaveBeenCalled();
    },
  );

  it.each(["--max-relationships", "--max-evidence", "--max-chars"])(
    "applies the same rule to %s",
    async (flag) => {
      expect((await runContext([flag, "10abc"])).error?.exitCode).toBe(1);
      expect((await runContext([flag, "1000"])).error).toBeUndefined();
    },
  );

  it("still tells the user each flag's default and range", async () => {
    // Removing the Commander defaults is what lets an absent flag be told apart
    // from one set to the default value — but it also removed `(default: "50")`
    // from `--help`, leaving four flags whose default a user could not discover
    // from the CLI at all while `--format` still showed its own.
    const program = new Command().name("ix").exitOverride();
    registerContextCommand(program);
    const help = program.commands.find((c) => c.name() === "context")!.helpInformation();

    // Whitespace-flattened: commander pads to a column and wraps a long
    // description onto the next line, so a per-line search finds the flag on
    // one line and its range on another. Flattening keeps the assertion about
    // which text belongs to which flag, which is the whole point of it.
    const flat = help.replace(/\s+/g, " ");
    for (const [flag, text, fallback, min, max] of [
      ["--max-entities", "Maximum entities in the bundle", 50, 1, 500],
      ["--max-relationships", "Maximum relationships in the bundle", 100, 1, 1000],
      ["--max-evidence", "Maximum evidence items in the bundle", 25, 1, 200],
      ["--max-chars", "Maximum characters of evidence output", 12000, 1000, 1000000],
    ] as const) {
      // One assertion per flag, so a failure names which one lost its default
      // rather than reporting that some string was missing from a wall of help.
      expect(flat, `help for ${flag}`).toContain(
        `${flag} <n> ${text} (default: ${fallback}, clamped to ${min}-${max})`,
      );
    }
  });
});

/**
 * `--as-of-rev` sat two lines from the budget flags with a bare
 * `parseInt(opts.asOfRev, 10)` behind it, and its value goes to the backend:
 * `--as-of-rev abc` sent NaN, `3.9` silently became 3, `10abc` became 10.
 */
describe("ix context --as-of-rev validation", () => {
  beforeEach(() => {
    resolveFileOrEntity.mockReset().mockResolvedValue(undefined);
  });

  it.each(["abc", "3.9", "10abc", "-1", "0"])("rejects %j rather than sending it", async (value) => {
    const result = await runContext(["--as-of-rev", value]);
    expect(result.error?.exitCode).toBe(1);
    expect(result.stderr).toContain("must be a positive integer");
    expect(resolveFileOrEntity).not.toHaveBeenCalled();
  });

  it("accepts a revision", async () => {
    expect((await runContext(["--as-of-rev", "12"])).error).toBeUndefined();
  });
});

describe("ix context --depth validation", () => {
  beforeEach(() => {
    resolveFileOrEntity.mockReset().mockResolvedValue(undefined);
  });

  it.each(["compact", "standard", "full", "shallow", "deep", "FULL"])("accepts depth %j", async (depth) => {
    const result = await runContext(["--depth", depth]);

    expect(result.error).toBeUndefined();
    expect(resolveFileOrEntity).toHaveBeenCalledOnce();
  });

  it.each([
    ["compact", "compact"],
    ["FULL", "full"],
    ["  Deep  ", "deep"],
  ])("normalizes a known depth %j to %j", (input, expected) => {
    expect(parseContextDepthOption(input)).toBe(expected);
  });

  /**
   * An unrecognized depth must NOT exit 1.
   *
   * The backend's limit selection ends in a `case _` that lands every
   * unrecognized value on the standard tier, so `--depth 2` has always run a
   * standard-depth query rather than failing. Anything already passing one is
   * a working pipeline, and turning it into a non-zero exit inside a patch
   * release breaks it on upgrade for no gain.
   */
  it.each(["2", "wide", "standard-ish"])("falls back to standard for %j instead of exiting", (depth) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseContextDepthOption(depth)).toBe("standard");
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0].join(" ")).toContain(`--depth ${depth}`);
      expect(warn.mock.calls[0].join(" ")).toContain("using standard");
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["2", "wide"])("still resolves the target after an unknown depth %j", async (depth) => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runContext(["--depth", depth]);

      expect(result.error).toBeUndefined();
      expect(resolveFileOrEntity).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on stderr, never stdout, so --format json stays parseable", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      parseContextDepthOption("nonsense");
      expect(warn).toHaveBeenCalledOnce();
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("ix context refusals reach the caller that asked for records", () => {
  beforeEach(() => {
    resolveFileOrEntity.mockReset().mockResolvedValue(undefined);
  });

  it("answers a missing target with a record and a non-zero status", async () => {
    // It was a `renderWarning` — console.log — with the exit code left at 0, so
    // an `llm` consumer got a prose line in its record stream and a script
    // could not tell "no target given" from a successful empty bundle.
    const out: string[] = [];
    const origLog = console.log;
    const priorExit = process.exitCode;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    try {
      process.exitCode = undefined;
      const program = new Command().name("ix").exitOverride();
      registerContextCommand(program);
      await program.parseAsync(["context", "--format", "llm"], { from: "user" });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/^error code=missing_target message="/);
      expect(process.exitCode).toBe(1);
    } finally {
      console.log = origLog;
      process.exitCode = priorExit;
    }
  });
});
