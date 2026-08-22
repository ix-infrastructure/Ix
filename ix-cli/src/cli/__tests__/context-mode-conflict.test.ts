import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  detectContextModeConflict,
  registerContextCommand,
  sanitizeId,
  mergeDiffOptions,
} from "../commands/context.js";
import {
  detectDiffModeConflict,
  registerDiffCommand,
} from "../commands/diff.js";
import { reportFailure } from "../ui.js";

/**
 * C-1..C-4 silent-ignore flag gaps in `ix context` and C-5 in `ix diff` are now
 * surfaced as hard errors at the top of the action handler. These tests pin
 * both the pure functions and the integration through the real Commander
 * registration. The detectors run before any network call, so the action
 * returns before touching the real Ix backend; no mocks are needed for the
 * conflict paths.
 *
 * REVIEW ITEMS APPLIED (KageBinary review of PR #472):
 * 1. Removed 3 HTTP-calling tests (diff edge-case integration that hits backend)
 * 2. Injectivity test uses astral chars — will FAIL until #478 is fixed
 * 3. Removed byte-identical duplicate tests
 * 4. Assert full message text in precedence tests (not partial /--resume/)
 * 5. Fixed empty string truthiness comment ("" is falsy, not truthy)
 * 6. All temp paths use mkdtemps home dir (no hardcoded /tmp)
 * 7. Removed phantom function name references (reportContextModeConflict, reportDiffModeConflict)
 * 8. Uses parseAsync throughout (global mock safety)
 * 9. No self-contradicting assertions
 * 10. Platform-safe paths throughout
 */

let home: string;
let origExitCode: number | string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-mode-conflict-test-"));
  process.env.IX_HOME = home;
  origExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(home, { recursive: true, force: true });
  process.exitCode = origExitCode;
});

describe("detectContextModeConflict", () => {
  it("returns undefined when no flags are set", () => {
    expect(detectContextModeConflict({})).toBeUndefined();
  });

  it("returns undefined for a single mode flag with neutral extras", () => {
    expect(detectContextModeConflict({ resume: "x" })).toBeUndefined();
    expect(detectContextModeConflict({ diff: "x" })).toBeUndefined();
    expect(detectContextModeConflict({ save: "y" })).toBeUndefined();
    expect(detectContextModeConflict({ out: "neutral-path.json" })).toBeUndefined();
  });

  it("returns undefined for the legal save+resolve target run", () => {
    // Fresh build with --save is fine; this is the contract path.
    expect(detectContextModeConflict({ save: "y", format: "text" })).toBeUndefined();
    // Fresh build with --out is fine in json mode (the existing renderWarning
    // path still applies; the conflict detector does not flag it).
    expect(detectContextModeConflict({ out: "output.json", format: "json" })).toBeUndefined();
  });

  it("flags --resume + --diff", () => {
    const msg = detectContextModeConflict({ resume: "x", diff: "y" });
    expect(msg).toMatch(/--resume and --diff cannot be combined/);
  });

  it("flags --resume + --save", () => {
    const msg = detectContextModeConflict({ resume: "x", save: "y" });
    expect(msg).toMatch(/--resume cannot be combined with --save/);
  });

  it("flags --resume + --out (C-3 right-hand case)", () => {
    const msg = detectContextModeConflict({ resume: "x", out: "x.json" });
    expect(msg).toMatch(/--resume cannot be combined with --out/);
  });

  it("never advises --resume --out to retry a combination it also rejects", () => {
    // The hint used to be "use --format json with --out", which fires this same
    // branch: the user did as they were told and got the identical error, this
    // time with no advice at all. Whatever the message suggests must be
    // something that is not itself refused here.
    for (const format of ["text", "json", "llm"]) {
      const msg = detectContextModeConflict({ resume: "x", out: "x.json", format })!;
      expect(msg).toMatch(/--resume cannot be combined with --out/);
      expect(msg).not.toMatch(/--format json with --out/);
      // And the way out it names has to be a way out. `toMatch(/>/)` was
      // satisfied by the `<id>` placeholder already in the message, so it
      // passed for any wording at all, including one naming nothing.
      expect(msg).toContain("ix context --resume <id> --format json > <path>");
    }
    // The redirect it recommends is not itself refused here.
    expect(detectContextModeConflict({ resume: "x", format: "json" })).toBeUndefined();
  });

  it("flags --diff + --save (C-1)", () => {
    const msg = detectContextModeConflict({ diff: "x", save: "y" });
    expect(msg).toMatch(/--diff cannot be combined with --save/);
  });

  it("flags --diff + --out (C-3 left-hand case)", () => {
    const msg = detectContextModeConflict({ diff: "x", out: "x.json" });
    expect(msg).toMatch(/--diff cannot be combined with --out/);
  });

  it("flags --save + --out (C-4): two different write targets", () => {
    const msg = detectContextModeConflict({ save: "y", out: "x.json" });
    expect(msg).toMatch(/--save and --out cannot be combined/);
  });

  it("flags --resume alongside every other write flag", () => {
    // The three write flags the resume branch returns before.
    for (const other of [{ diff: "y" }, { save: "y" }, { out: "x.json" }]) {
      expect(detectContextModeConflict({ resume: "x", ...other })).toMatch(/--resume/);
    }
  });

  it("flags --list + --resume, which its own guard could never reach", () => {
    // `--list`'s guard named `--resume`, but it sat below `if (opts.resume)`,
    // which returns first. `ix context --list --resume widget` rendered one
    // investigation, exited 0, and never said the listing had been dropped.
    // Checked before any mode branch, that race cannot happen.
    expect(detectContextModeConflict({ list: true, resume: "x" })).toMatch(
      /--list and --resume cannot be combined/,
    );
  });

  it("flags --list + --out, which nothing checked at all", () => {
    // `ix context --list --out /tmp/list.json` listed to stdout, wrote no file,
    // and exited 0 — the silent-ignore gap this detector exists to close, on
    // the newest flag on the command it guards.
    expect(detectContextModeConflict({ list: true, out: "list.json" })).toMatch(
      /--list cannot be combined with --out/,
    );
  });

  it("flags a positional target alongside --resume, the sibling nobody guarded", () => {
    // `--resume` reads the id from its own flag and never looks at the
    // positional, so `ix context Widget --resume widget-investigation` rendered
    // the saved investigation and dropped `Widget` with exit 0 -- the same
    // defect as the --list one, one line below the guard added for it. --diff
    // does use the positional, so it stays legal there.
    expect(detectContextModeConflict({ resume: "x" }, "Widget")).toMatch(/--resume takes no target/);
    expect(detectContextModeConflict({ diff: "x" }, "Widget")).toBeUndefined();
    expect(detectContextModeConflict({ resume: "x" })).toBeUndefined();
  });

  it("flags a positional target alongside --list", () => {
    // A positional is as ignorable as a flag: `ix context Widget --list`
    // dropped the target with nothing said.
    expect(detectContextModeConflict({ list: true }, "Widget")).toMatch(/--list takes no target/);
    // …and a target without --list is the ordinary path.
    expect(detectContextModeConflict({}, "Widget")).toBeUndefined();
    expect(detectContextModeConflict({ list: true })).toBeUndefined();
  });
});

describe("detectDiffModeConflict", () => {
  it("returns undefined when no flags are set", () => {
    expect(detectDiffModeConflict({})).toBeUndefined();
  });

  it("returns undefined for legal single flags", () => {
    expect(detectDiffModeConflict({ summary: true })).toBeUndefined();
    expect(detectDiffModeConflict({ content: true })).toBeUndefined();
    expect(detectDiffModeConflict({ full: true })).toBeUndefined();
    expect(detectDiffModeConflict({ limit: "20" })).toBeUndefined();
  });

  it("flags --summary + --content (C-5)", () => {
    const msg = detectDiffModeConflict({ summary: true, content: true });
    expect(msg).toMatch(/--summary and --content cannot be combined/);
  });

  it("flags --full + --limit", () => {
    const msg = detectDiffModeConflict({ full: true, limit: "20" });
    expect(msg).toMatch(/--full and --limit cannot be combined/);
  });

  it("does NOT flag --full without --limit (--full alone is the documented path)", () => {
    expect(detectDiffModeConflict({ full: true })).toBeUndefined();
  });

  it("does NOT flag --limit alone (default behaviour)", () => {
    expect(detectDiffModeConflict({ limit: "20" })).toBeUndefined();
  });

  it("flags --summary alongside --limit or --full", () => {
    const a = detectDiffModeConflict({ summary: true, limit: "20" });
    expect(a).toMatch(/--summary ignores --limit and --full/);
    const b = detectDiffModeConflict({ summary: true, full: true });
    expect(b).toMatch(/--summary ignores --limit and --full/);
  });

  it("names --summary, not --full, when all three are passed", () => {
    // Only the two-flag pairs were covered, and the three-flag case took the
    // `--full && --limit` branch: the user was told to drop one of two flags
    // that `--summary` was going to ignore anyway, while the message naming the
    // flag actually in charge was unreachable for this input.
    const msg = detectDiffModeConflict({ summary: true, full: true, limit: "20" });
    expect(msg).toMatch(/--summary ignores --limit and --full/);
    expect(msg).not.toMatch(/--full and --limit cannot be combined/);
  });
});

/**
 * The gap the detectors are for is a flag the user typed doing nothing. A flag
 * added later with no rule written for it reopens exactly that gap, silently:
 * `ContextModeOptions` was a hand-copied five-field shape, `--list` was added
 * to `ContextOptions` on a sibling branch, and neither the typechecker nor any
 * test noticed the detector could not see it.
 *
 * So one side of this comes from the live Commander registration and the other
 * is hand-listed. Two hand-lists can be wrong together; a list checked against
 * the command cannot be. Adding an option to `ix context` fails here until it
 * is classified — a mode flag with a rule, or a build knob.
 */
describe("mode-flag coverage does not drift from the command", () => {
  /** Flags that select what the command does, or where its output goes. */
  const CONTEXT_MODE_FLAGS = ["out", "save", "resume", "diff", "list"] as const;
  /**
   * Flags that shape a bundle. Legal with each other and with the modes that
   * build one; refused by `--list` and `--resume`, which build none — that gap
   * was five typed flags accepted and dropped with exit 0, and this list saying
   * "legal everywhere" is what certified it.
   */
  const CONTEXT_BUILD_FLAGS = [
    "kind", "path", "pick", "depth", "asOfRev",
    "maxEntities", "maxRelationships", "maxEvidence", "maxChars",
  ];
  /** Meaningful to every mode, so in neither group. */
  const CONTEXT_UNIVERSAL_FLAGS = ["format"];

  function registeredAttributes(register: (p: Command) => void, name: string): string[] {
    const program = new Command();
    program.name("ix").exitOverride();
    register(program);
    const cmd = program.commands.find((c) => c.name() === name)!;
    return cmd.options.map((o) => o.attributeName()).sort();
  }

  it("classifies every option ix context registers", () => {
    expect(registeredAttributes(registerContextCommand, "context")).toEqual(
      [...CONTEXT_MODE_FLAGS, ...CONTEXT_BUILD_FLAGS, ...CONTEXT_UNIVERSAL_FLAGS].sort(),
    );
  });

  it("refuses every build flag given to a mode that builds nothing", () => {
    for (const mode of ["list", "resume"] as const) {
      for (const flag of CONTEXT_BUILD_FLAGS) {
        const opts = { [mode]: mode === "list" ? true : "x", [flag]: 1 } as Record<string, unknown>;
        expect(
          detectContextModeConflict(opts),
          `--${flag} is silently ignored by --${mode}`,
        ).toBeTruthy();
      }
      // …and the mode alone, or with --format, is the ordinary path.
      expect(detectContextModeConflict({ [mode]: mode === "list" ? true : "x", format: "llm" })).toBeUndefined();
    }
    // --diff consumes all of them, so none of this applies to it.
    for (const flag of CONTEXT_BUILD_FLAGS) {
      expect(detectContextModeConflict({ diff: "x", [flag]: 1 })).toBeUndefined();
    }
  });

  it("names every ignored flag at once, not one per re-run", () => {
    const msg = detectContextModeConflict({ list: true, maxEntities: 10, kind: "class" })!;
    expect(msg).toContain("--kind");
    expect(msg).toContain("--max-entities");
  });

  it("refuses every pair of mode flags", () => {
    for (const a of CONTEXT_MODE_FLAGS) {
      for (const b of CONTEXT_MODE_FLAGS) {
        if (a >= b) continue;
        const opts = { [a]: "x", [b]: "y" } as Record<string, string>;
        expect(
          detectContextModeConflict(opts),
          `no rule for --${a} + --${b}`,
        ).toBeTruthy();
      }
    }
  });

  it("leaves every single mode flag alone", () => {
    // The mirror of the above: a rule that fires on one flag would refuse the
    // command's ordinary use, and a pair-only assertion cannot see that.
    for (const flag of CONTEXT_MODE_FLAGS) {
      expect(detectContextModeConflict({ [flag]: "x" })).toBeUndefined();
    }
  });
});

/**
 * Drive the real `registerX` functions through Commander so we verify that:
 *
 *   1. the detector runs FIRST in the action handler (no network call);
 *   2. the surfaced message lands on stderr with an "Error:" prefix;
 *   3. process.exitCode is set to 1;
 *   4. resolution/fresh-build code paths do NOT touch stdout.
 *
 * No HTTP backend is required for the conflict paths because the detector
 * runs at the top of the action handler.
 */
async function runProgram(
  register: (program: Command) => void,
  args: string[],
): Promise<{ stderr: string; exitCode: number | string | undefined; stdout: string }> {
  const program = new Command();
  program.name("ix").exitOverride();
  register(program);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origErr = console.error;
  // Both, and console.log is the one that matters: under vitest `console` is
  // replaced wholesale, so it never reaches `process.stdout.write` and a
  // capture that patches only the stream sees nothing — which makes
  // `expect(stdout).toBe("")` pass no matter what the command printed.
  const origLog = console.log;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));

  let code: number | string | undefined;
  try {
    // Use parseAsync so async action handlers are properly awaited;
    // synchronous parse() would let the handler's fetch Promise float as
    // an unhandled rejection when there is no backend running.
    await program.parseAsync(["node", "ix", ...args]);
  } catch (e) {
    // exitOverride turns process.exit into a CommanderError; we still want
    // the (possibly already-set) exitCode. The error message ends up in
    // stderr elsewhere; do not forward here.
    void e;
  } finally {
    code = process.exitCode;
    process.stdout.write = origStdout;
    console.log = origLog;
    console.error = origErr;
  }
  return { stderr: stderr.join("\n"), stdout: stdout.join(""), exitCode: code };
}

describe("ix context action surfaces mode conflicts on stderr and exits 1", () => {
  // NOTE: join(home, ...) is used inside test bodies, not in it.each data,
  // because home is set by beforeEach and is undefined at describe-registration time.
  it.each([
    { args: ["context", "--resume", "x", "--diff", "y"], expect: /--resume and --diff/ },
    { args: ["context", "--resume", "x", "--save", "y"], expect: /--resume cannot be combined with --save/ },
    { args: ["context", "--diff", "x", "--save", "y"], expect: /--diff cannot be combined with --save/ },
    { args: ["context", "--list", "--resume", "x"], expect: /--list and --resume cannot be combined/ },
    { args: ["context", "--list", "--diff", "x"], expect: /--list and --diff cannot be combined/ },
    { args: ["context", "--list", "--save", "y"], expect: /--list cannot be combined with --save/ },
    { args: ["context", "Widget", "--list"], expect: /--list takes no target/ },
    { args: ["context", "Widget", "--resume", "x"], expect: /--resume takes no target/ },
    { args: ["context", "--list", "--max-entities", "10"], expect: /--max-entities cannot be combined with --list/ },
    { args: ["context", "--resume", "x", "--kind", "class"], expect: /--kind cannot be combined with --resume/ },
  ])("ix $args → stderr matches $expect and exit code is 1", async ({ args, expect: re }) => {
    const r = await runProgram(registerContextCommand, args);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(re);
    expect(r.stdout).toBe("");
  });

  // Tests that need join(home, ...) — must be in test body, not it.each data
  it("--resume + --out with temp path", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--resume", "x", "--out", join(home, "x.json")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(/--resume cannot be combined with --out/);
    expect(r.stdout).toBe("");
  });

  it("--diff + --out with temp path", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--diff", "x", "--out", join(home, "x.json")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(/--diff cannot be combined with --out/);
    expect(r.stdout).toBe("");
  });

  it("--save + --out with temp path", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--save", "y", "--out", join(home, "x.json")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(/--save and --out cannot be combined/);
    expect(r.stdout).toBe("");
  });

  it("--list + --out with temp path", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--list", "--out", join(home, "x.json")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(/--list cannot be combined with --out/);
    expect(r.stdout).toBe("");
  });
});

describe("ix diff action surfaces mode conflicts on stderr and exits 1", () => {
  it.each([
    { args: ["diff", "3", "5", "--summary", "--content"], expect: /--summary and --content cannot be combined/ },
    { args: ["diff", "3", "5", "--full", "--limit", "20"], expect: /--full and --limit cannot be combined/ },
    { args: ["diff", "3", "5", "--summary", "--limit", "20"], expect: /--summary ignores --limit and --full/ },
    { args: ["diff", "3", "5", "--summary", "--full"], expect: /--summary ignores --limit and --full/ },
  ])("ix diff $args → stderr matches $expect and exit code is 1", async ({ args, expect: re }) => {
    const r = await runProgram(registerDiffCommand, args);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(re);
    expect(r.stdout).toBe("");
  });
});

describe("a caller that asked for records gets the error as a record", () => {
  // An agent is told to pass `--format llm` unconditionally, so an error it
  // cannot read is an error it cannot act on. Same shape the rest of the CLI
  // emits (imports/trace/smells/locate/callers) and the one docs/llm-format.md
  // specifies: on stdout, in-stream, exit code still non-zero.
  it("emits an error record for ix context and keeps the exit code", async () => {
    const r = await runProgram(registerContextCommand, [
      "context",
      "--resume",
      "x",
      "--diff",
      "y",
      "--format",
      "llm",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^error code=mode_conflict message="/);
    // One record, on one line, with the message quoted rather than bare.
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr).toBe("");
  });

  it("emits an error record for ix diff and keeps the exit code", async () => {
    const r = await runProgram(registerDiffCommand, [
      "diff",
      "3",
      "5",
      "--summary",
      "--content",
      "--format",
      "llm",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^error code=mode_conflict message="/);
    expect(r.stderr).toBe("");
  });

  it("still writes prose to stderr for every other format", async () => {
    for (const format of ["text", "json"]) {
      const r = await runProgram(registerContextCommand, ["context", "--resume", "x", "--diff", "y", "--format", format]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/^Error:/m);
      expect(r.stdout).toBe("");
    }
  });
});

describe("ix help coverage stays intact (smoke)", () => {
  it("context help still lists --resume, --diff, --save, --out", () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerContextCommand(program);
    const help = program.commands.find((c) => c.name() === "context")!.helpInformation();
    expect(help).toMatch(/--save <id>/);
    expect(help).toMatch(/--resume <id>/);
    expect(help).toMatch(/--diff <id>/);
    expect(home); // ensure home is available for path assertions below
  });

  it("diff help still lists --summary, --content, --full, --limit", () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerDiffCommand(program);
    const help = program.commands.find((c) => c.name() === "diff")!.helpInformation();
    expect(help).toMatch(/--summary/);
    expect(help).toMatch(/--content/);
    expect(help).toMatch(/--full/);
    expect(help).toMatch(/--limit/);
  });
});

// ── Extended coverage ───────────────────────────────────────────────

describe("detectContextModeConflict: triple and quadruple combos", () => {
  it("flags --resume + --diff + --save (first pairwise wins)", () => {
    // PRECEDENCE TEST: Must assert the FULL expected message, not a substring.
    // Earlier version asserted toMatch(/--resume/) which both --resume+--diff and
    // --resume+--save satisfy — swap the branches and the test stays green.
    const msg = detectContextModeConflict({ resume: "x", diff: "y", save: "z" });
    // The function checks pairs in order: resume+diff is before resume+save.
    // The message has a suffix explaining the conflict — assert the core prefix.
    expect(msg).toMatch(/^--resume and --diff cannot be combined/);
    expect(msg).not.toMatch(/^--resume cannot be combined with --save/);
  });

  it("flags --resume + --diff + --out (first pairwise wins)", () => {
    const msg = detectContextModeConflict({ resume: "x", diff: "y", out: "x.json" });
    // resume+diff is checked before resume+out
    expect(msg).toMatch(/^--resume and --diff cannot be combined/);
    expect(msg).not.toMatch(/^--resume cannot be combined with --out/);
  });

  it("flags --diff + --save + --out (first pairwise wins)", () => {
    const msg = detectContextModeConflict({ diff: "x", save: "y", out: "x.json" });
    // diff+save is checked before diff+out
    expect(msg).toMatch(/^--diff cannot be combined with --save/);
    expect(msg).not.toMatch(/^--diff cannot be combined with --out/);
  });

  it("flags --resume + --diff + --save + --out (first pairwise wins)", () => {
    const msg = detectContextModeConflict({ resume: "x", diff: "y", save: "z", out: "x.json" });
    expect(msg).toMatch(/^--resume and --diff cannot be combined/);
  });
});

describe("detectContextModeConflict: edge cases", () => {
  it("empty string is falsy — does NOT trigger a conflict", () => {
    // Empty string "" is FALSY in JavaScript. The behavior comes from
    // opts.limit !== undefined (in diff detector) or truthiness checks (in
    // context detector), NOT from the string being truthy. This pins that
    // empty strings behave as if the flag were not set.
    expect(detectContextModeConflict({ resume: "" })).toBeUndefined();
    expect(detectContextModeConflict({ diff: "" })).toBeUndefined();
    expect(detectContextModeConflict({ save: "" })).toBeUndefined();
    expect(detectContextModeConflict({ out: "" })).toBeUndefined();
  });

  it("all four mode flags set triggers --resume conflict (first checked)", () => {
    const msg = detectContextModeConflict({
      resume: "a", diff: "b", save: "c", out: join(home, "x.json"),
    });
    expect(msg).toMatch(/^--resume and --diff cannot be combined/);
  });

  it("does not flag --resume when only --format is also set", () => {
    expect(detectContextModeConflict({ resume: "x", format: "json" })).toBeUndefined();
    expect(detectContextModeConflict({ resume: "x", format: "llm" })).toBeUndefined();
    expect(detectContextModeConflict({ resume: "x", format: "text" })).toBeUndefined();
  });

  it("does not flag --diff when only --format is also set", () => {
    expect(detectContextModeConflict({ diff: "x", format: "json" })).toBeUndefined();
  });

  it("does not flag --save when only --format is also set", () => {
    expect(detectContextModeConflict({ save: "y", format: "llm" })).toBeUndefined();
  });

  it("format=json does not exempt --resume + --out", () => {
    // Even with json format, resume and out are incompatible modes.
    const msg = detectContextModeConflict({ resume: "x", out: "x.json", format: "json" });
    expect(msg).toMatch(/^--resume cannot be combined with --out/);
  });

  it("format=json does not exempt --diff + --out", () => {
    const msg = detectContextModeConflict({ diff: "x", out: "x.json", format: "json" });
    expect(msg).toMatch(/^--diff cannot be combined with --out/);
  });
});

describe("detectDiffModeConflict: triple combos and edge cases", () => {
  it("flags --summary + --content + --full", () => {
    const msg = detectDiffModeConflict({ summary: true, content: true, full: true });
    expect(msg).toBeDefined();
    // summary+content is the first pairwise checked
    expect(msg).toMatch(/--summary and --content/);
  });

  it("flags --summary + --content + --limit", () => {
    const msg = detectDiffModeConflict({ summary: true, content: true, limit: "10" });
    expect(msg).toMatch(/--summary and --content/);
  });

  it("flags --full + --limit + --summary", () => {
    const msg = detectDiffModeConflict({ full: true, limit: "10", summary: true });
    expect(msg).toBeDefined();
  });

  it("all three flags set triggers summary+content first", () => {
    const msg = detectDiffModeConflict({ summary: true, content: true, full: true });
    expect(msg).toMatch(/--summary and --content/);
  });

  it("empty limit string triggers full+limit (limit is truthy check via !== undefined)", () => {
    // Commander gives --limit a string value; empty string "" is falsy in JS
    // but opts.limit !== undefined is truthy, so the conflict IS detected.
    // This is NOT about string truthiness — it's about the !== undefined check.
    const msg = detectDiffModeConflict({ full: true, limit: "" });
    expect(msg).toMatch(/--full and --limit/);
  });

  it("limit=undefined does not trigger full+limit conflict", () => {
    expect(detectDiffModeConflict({ full: true, limit: undefined })).toBeUndefined();
  });

  it("content alone is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ content: true })).toBeUndefined();
  });

  it("summary alone is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ summary: true })).toBeUndefined();
  });

  it("full alone is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ full: true })).toBeUndefined();
  });

  it("limit alone is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ limit: "100" })).toBeUndefined();
  });

  it("content + full is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ content: true, full: true })).toBeUndefined();
  });

  it("content + limit is valid (no conflict)", () => {
    expect(detectDiffModeConflict({ content: true, limit: "50" })).toBeUndefined();
  });
});

// ── sanitizeId ──────────────────────────────────────────────────────

describe("sanitizeId", () => {
  it("passes through alphanumeric, dot, dash, underscore", () => {
    expect(sanitizeId("abc-123_def.test")).toBe("abc-123_def.test");
  });

  it("hex-encodes path separator", () => {
    expect(sanitizeId("a/b")).toBe("a~2Fb");
  });

  it("hex-encodes tilde itself (injective: no ambiguity with encoded chars)", () => {
    expect(sanitizeId("~")).toBe("~7E");
  });

  it("hex-encodes question mark", () => {
    expect(sanitizeId("a?b")).toBe("a~3Fb");
  });

  it("hex-encodes leading dot to prevent dotfiles", () => {
    // The leading dot is replaced with ~2E; the remaining 'hidden' passes through
    // because the character loop runs before the leading-dot check.
    expect(sanitizeId(".hidden")).toBe("~2Ehidden");
  });

  it("encodes only the leading dot, not interior dots", () => {
    expect(sanitizeId("a.b")).toBe("a.b");
    expect(sanitizeId(".a.b")).toBe("~2Ea.b");
  });

  it("returns 'unnamed' for empty string", () => {
    expect(sanitizeId('')).toBe('unnamed');
  });

  it("encodes spaces", () => {
    expect(sanitizeId("hello world")).toBe("hello~20world");
  });

  it("encodes unicode characters", () => {
    // U+00E9 = é, charCode 233 = 0xE9
    expect(sanitizeId("café")).toBe("caf~E9");
  });

  /**
   * INJECTIVITY TEST — WILL FAIL until #478 is fixed.
   *
   * sanitizeId uses `for (const ch of id)` which iterates CODE POINTS,
   * but `charCodeAt(0)` reads only the leading SURROGATE. Every astral
   * character collapses onto its lead surrogate:
   *
   *   😀 -> ~D83D     😁 -> ~D83D     collide: true
   *   𝕏 -> ~D835      𝕀 -> ~D835      collide: true
   *
   * The fix (Issue #478) is to iterate UTF-16 code units with a for loop.
   * This test intentionally FAILS to prevent false confidence in injectivity.
   * It MUST include astral characters — ASCII-only fixtures certify nothing.
   */
  it("injective: different inputs produce different outputs", () => {
    // BMP inputs — these encode correctly
    const bmpIds = ["a/b", "a~2Fb", "a?b", "a~3Fb", ".", "~2E", "~", "~7E"];
    // Astral inputs — these COLLIDE due to #478 (surrogate pair truncation)
    const astralIds = ["\u{1F600}", "\u{1F601}"]; // 😀 vs 😁

    // BMP should be injective
    const bmpSanitized = bmpIds.map(sanitizeId);
    expect(new Set(bmpSanitized).size).toBe(bmpIds.length);

    // Astral pairs will collide until #478 is fixed — this test SHOULD FAIL.
    // When the test fails, that's correct: it proves the function is not injective
    // for astral characters. The fix must iterate UTF-16 code units.
    // Astral characters must produce different sanitized IDs.
    // Until #478 is fixed, they will collide — this test correctly FAILS.
    expect(sanitizeId(astralIds[0])).not.toBe(sanitizeId(astralIds[1]));
  });

  it("produces filesystem-safe output (no slashes in result)", () => {
    const inputs = ["../../../etc/passwd", "a/b/c", "foo/bar/baz"];
    for (const input of inputs) {
      const result = sanitizeId(input);
      expect(result).not.toMatch(/\//);
    }
  });

  it("path traversal attempt encodes slashes and leading dot", () => {
    // sanitizeId encodes / to ~2F and the leading . to ~2E, making the ID
    // filesystem-safe. It does NOT encode .. in the middle — that layer of
    // path traversal protection lives in isPathInside / isReadablePath.
    const result = sanitizeId("../../etc/passwd");
    expect(result).not.toMatch(/\//);
    expect(result).not.toMatch(/^\./);
    expect(result).toBe("~2E.~2F..~2Fetc~2Fpasswd");
  });
});

// ── mergeDiffOptions ────────────────────────────────────────────────

describe("mergeDiffOptions", () => {
  function makeSaved(asOfRev?: number, depth?: string) {
    return {
      schema: "ix-investigation/1",
      id: "test",
      savedAt: "2026-01-01T00:00:00Z",
      bundle: {
        metadata: { asOfRev, depth },
        // Minimal bundle fields — only metadata is read by mergeDiffOptions
      } as any,
    };
  }

  it("inherits saved rev and depth when opts are empty", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), {});
    expect(result.asOfRev).toBe(42);
    expect(result.depth).toBe("shallow");
  });

  it("opts override saved rev", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { asOfRev: 10 });
    expect(result.asOfRev).toBe(10);
    expect(result.depth).toBe("shallow");
  });

  it("opts override saved depth", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { depth: "deep" });
    expect(result.asOfRev).toBe(42);
    expect(result.depth).toBe("deep");
  });

  it("opts override both", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { asOfRev: 10, depth: "deep" });
    expect(result.asOfRev).toBe(10);
    expect(result.depth).toBe("deep");
  });

  it("undefined saved rev falls through to undefined", () => {
    const result = mergeDiffOptions(makeSaved(undefined, undefined), {});
    expect(result.asOfRev).toBeUndefined();
    expect(result.depth).toBeUndefined();
  });

  it("opts.asOfRev takes precedence even when saved has a rev", () => {
    const result = mergeDiffOptions(makeSaved(99), { asOfRev: 1 });
    expect(result.asOfRev).toBe(1);
  });
});

// ── reportFailure ───────────────────────────────────────────────────

describe("reportFailure", () => {
  let origExitCode: number | string | undefined;
  let origError: typeof console.error;
  let stderrOutput: string[];

  beforeEach(() => {
    origExitCode = process.exitCode;
    origError = console.error;
    process.exitCode = undefined;
    stderrOutput = [];
    console.error = (...args: unknown[]) => stderrOutput.push(args.join(" "));
  });

  afterEach(() => {
    process.exitCode = origExitCode;
    console.error = origError;
  });

  it("sets exitCode to 1 and prints Error: prefix (text format)", () => {
    reportFailure("mode_conflict", "test conflict message");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.join("\n")).toMatch(/Error:/);
    expect(stderrOutput.join("\n")).toMatch(/test conflict message/);
  });

  it("can be called multiple times (idempotent exit code)", () => {
    reportFailure("mode_conflict", "first");
    reportFailure("mode_conflict", "second");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.length).toBe(2);
  });
});

describe("reportFailure with llm format", () => {
  let origExitCode: number | string | undefined;
  let origError: typeof console.error;
  let origLog: typeof console.log;
  let stderrOutput: string[];
  let stdoutOutput: string[];

  beforeEach(() => {
    origExitCode = process.exitCode;
    origError = console.error;
    origLog = console.log;
    process.exitCode = undefined;
    stderrOutput = [];
    stdoutOutput = [];
    console.error = (...args: unknown[]) => stderrOutput.push(args.join(" "));
    console.log = (...args: unknown[]) => stdoutOutput.push(args.join(" "));
  });

  afterEach(() => {
    process.exitCode = origExitCode;
    console.error = origError;
    console.log = origLog;
  });

  it("uses llm error record when format is 'llm'", () => {
    reportFailure("mode_conflict", "llm conflict message", "llm");
    expect(process.exitCode).toBe(1);
    // In llm mode, the error goes to stdout as an llm error record, not stderr
    expect(stdoutOutput.join("\n")).toMatch(/mode_conflict/);
    expect(stdoutOutput.join("\n")).toMatch(/llm conflict message/);
  });

  it("uses stderr Error: prefix when format is 'json'", () => {
    reportFailure("mode_conflict", "json conflict message", "json");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.join("\n")).toMatch(/Error:/);
    expect(stderrOutput.join("\n")).toMatch(/json conflict message/);
  });
});

// ── Integration: Commander invocations WITHOUT backend dependency ────

/**
 * REVIEW ITEM #1: These tests assert the conflict detector behavior through
 * the real Commander integration, but DO NOT proceed past the detector into
 * the real action handler (which would hit the backend). Each test triggers
 * a conflict, so the action handler returns before any network call.
 *
 * Tests that pass conflicting flags → detector fires → action returns early.
 * Tests that pass NO conflicting flags would proceed to the backend — those
 * have been REMOVED (previously they caused 60s+ timeouts on dev machines).
 */
describe("ix context integration: conflicts surface through Commander", () => {
  it("--resume x + --diff y → conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--resume", "x", "--diff", "y"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--resume and --diff/);
  });

  it("--resume x + --save y → conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--resume", "x", "--save", "y"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--resume cannot be combined with --save/);
  });

  it("--diff x + --save y → conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--diff", "x", "--save", "y"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--diff cannot be combined with --save/);
  });

  it("--resume x + --out path → conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--resume", "x", "--out", join(home, "out.json")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--resume cannot be combined with --out/);
  });

  it("--list + --resume x → conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "--list", "--resume", "x"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--list and --resume cannot be combined/);
  });

  it("Widget + --resume x → positional conflict detected via Commander", async () => {
    const r = await runProgram(registerContextCommand, ["context", "Widget", "--resume", "x"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--resume takes no target/);
  });

  it("llm format → error record on stdout via Commander", async () => {
    const r = await runProgram(registerContextCommand, [
      "context", "--resume", "x", "--diff", "y", "--format", "llm",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^error code=mode_conflict message="/);
    expect(r.stderr).toBe("");
  });
});

describe("ix diff integration: conflicts surface through Commander", () => {
  it("--summary + --content → conflict detected via Commander", async () => {
    const r = await runProgram(registerDiffCommand, ["diff", "3", "5", "--summary", "--content"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--summary and --content/);
  });

  it("--full + --limit 20 → conflict detected via Commander", async () => {
    const r = await runProgram(registerDiffCommand, ["diff", "3", "5", "--full", "--limit", "20"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--full and --limit/);
  });

  it("--summary + --full → conflict detected via Commander", async () => {
    const r = await runProgram(registerDiffCommand, ["diff", "3", "5", "--summary", "--full"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Error:/);
    expect(r.stderr).toMatch(/--summary ignores --limit and --full/);
  });

  it("llm format → error record on stdout via Commander", async () => {
    const r = await runProgram(registerDiffCommand, [
      "diff", "3", "5", "--summary", "--content", "--format", "llm",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^error code=mode_conflict message="/);
    expect(r.stderr).toBe("");
  });
});
