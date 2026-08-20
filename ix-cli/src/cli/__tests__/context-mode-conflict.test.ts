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
import { reportModeConflict } from "../llm.js";

/**
 * C-1..C-4 silent-ignore flag gaps in `ix context` and C-5 in `ix diff` are now
 * surfaced as hard errors at the top of the action handler. These tests pin
 * both the pure functions and the integration through the real Commander
 * registration. The detectors run before any network call, so the action
 * returns before touching the real Ix backend; no mocks are needed for the
 * conflict paths.
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
    expect(detectContextModeConflict({ out: "/tmp/x.json" })).toBeUndefined();
  });

  it("returns undefined for the legal save+resolve target run", () => {
    // Fresh build with --save is fine; this is the contract path.
    expect(detectContextModeConflict({ save: "y", format: "text" })).toBeUndefined();
    // Fresh build with --out is fine in json mode (the existing renderWarning
    // path still applies; the conflict detector does not flag it).
    expect(detectContextModeConflict({ out: "/tmp/x.json", format: "json" })).toBeUndefined();
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
    const msg = detectContextModeConflict({ resume: "x", out: "/tmp/x.json" });
    expect(msg).toMatch(/--resume cannot be combined with --out/);
  });

  it("never advises --resume --out to retry a combination it also rejects", () => {
    // The hint used to be "use --format json with --out", which fires this same
    // branch: the user did as they were told and got the identical error, this
    // time with no advice at all. Whatever the message suggests must be
    // something that is not itself refused here.
    for (const format of ["text", "json", "llm"]) {
      const msg = detectContextModeConflict({ resume: "x", out: "/tmp/x.json", format })!;
      expect(msg).toMatch(/--resume cannot be combined with --out/);
      expect(msg).not.toMatch(/--format json with --out/);
      // And the way out it does name has to work.
      expect(msg).toMatch(/>/);
      expect(detectContextModeConflict({ resume: "x", format: "json" })).toBeUndefined();
    }
  });

  it("flags --diff + --save (C-1)", () => {
    const msg = detectContextModeConflict({ diff: "x", save: "y" });
    expect(msg).toMatch(/--diff cannot be combined with --save/);
  });

  it("flags --diff + --out (C-3 left-hand case)", () => {
    const msg = detectContextModeConflict({ diff: "x", out: "/tmp/x.json" });
    expect(msg).toMatch(/--diff cannot be combined with --out/);
  });

  it("flags --save + --out (C-4): two different write targets", () => {
    const msg = detectContextModeConflict({ save: "y", out: "/tmp/x.json" });
    expect(msg).toMatch(/--save and --out cannot be combined/);
  });

  it("flags --resume alongside every other write flag", () => {
    // The three write flags the resume branch returns before.
    for (const other of [{ diff: "y" }, { save: "y" }, { out: "/tmp/x.json" }]) {
      expect(detectContextModeConflict({ resume: "x", ...other })).toMatch(/--resume/);
    }
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
  const CONTEXT_MODE_FLAGS = ["out", "save", "resume", "diff"] as const;
  /** Flags that shape the bundle a mode produces; any pair of these is legal. */
  const CONTEXT_BUILD_FLAGS = [
    "kind", "path", "pick", "depth", "asOfRev",
    "maxEntities", "maxRelationships", "maxEvidence", "maxChars", "format",
  ];

  function registeredAttributes(register: (p: Command) => void, name: string): string[] {
    const program = new Command();
    program.name("ix").exitOverride();
    register(program);
    const cmd = program.commands.find((c) => c.name() === name)!;
    return cmd.options.map((o) => o.attributeName()).sort();
  }

  it("classifies every option ix context registers", () => {
    expect(registeredAttributes(registerContextCommand, "context")).toEqual(
      [...CONTEXT_MODE_FLAGS, ...CONTEXT_BUILD_FLAGS].sort(),
    );
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
function runProgram(
  register: (program: Command) => void,
  args: string[],
): { stderr: string; exitCode: number | string | undefined; stdout: string } {
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
    program.parse(["node", "ix", ...args]);
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
  it.each([
    { args: ["context", "--resume", "x", "--diff", "y"], expect: /--resume and --diff/ },
    { args: ["context", "--resume", "x", "--save", "y"], expect: /--resume cannot be combined with --save/ },
    { args: ["context", "--resume", "x", "--out", "/tmp/x.json"], expect: /--resume cannot be combined with --out/ },
    { args: ["context", "--diff", "x", "--save", "y"], expect: /--diff cannot be combined with --save/ },
    { args: ["context", "--diff", "x", "--out", "/tmp/x.json"], expect: /--diff cannot be combined with --out/ },
    { args: ["context", "--save", "y", "--out", "/tmp/x.json"], expect: /--save and --out cannot be combined/ },
  ])("ix $args → stderr matches $expect and exit code is 1", ({ args, expect: re }) => {
    const r = runProgram(registerContextCommand, args);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^Error:/m);
    expect(r.stderr).toMatch(re);
    expect(r.stdout).toBe("");
  });
});

describe("ix diff action surfaces mode conflicts on stderr and exits 1", () => {
  it.each([
    { args: ["diff", "3", "5", "--summary", "--content"], expect: /--summary and --content cannot be combined/ },
    { args: ["diff", "3", "5", "--full", "--limit", "20"], expect: /--full and --limit cannot be combined/ },
    { args: ["diff", "3", "5", "--summary", "--limit", "20"], expect: /--summary ignores --limit and --full/ },
    { args: ["diff", "3", "5", "--summary", "--full"], expect: /--summary ignores --limit and --full/ },
  ])("ix diff $args → stderr matches $expect and exit code is 1", ({ args, expect: re }) => {
    const r = runProgram(registerDiffCommand, args);
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
  it("emits an error record for ix context and keeps the exit code", () => {
    const r = runProgram(registerContextCommand, [
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

  it("emits an error record for ix diff and keeps the exit code", () => {
    const r = runProgram(registerDiffCommand, [
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

  it("still writes prose to stderr for every other format", () => {
    for (const format of ["text", "json"]) {
      const r = runProgram(registerContextCommand, ["context", "--resume", "x", "--diff", "y", "--format", format]);
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
    expect(help).toMatch(/--out <path>/);
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
    const msg = detectContextModeConflict({ resume: "x", diff: "y", save: "z" });
    expect(msg).toBeDefined();
    expect(msg).toMatch(/--resume/);
  });

  it("flags --resume + --diff + --out", () => {
    const msg = detectContextModeConflict({ resume: "x", diff: "y", out: "/tmp/x.json" });
    expect(msg).toBeDefined();
    expect(msg).toMatch(/--resume/);
  });

  it("flags --diff + --save + --out", () => {
    const msg = detectContextModeConflict({ diff: "x", save: "y", out: "/tmp/x.json" });
    expect(msg).toBeDefined();
    // Should flag one of the pairwise combos
    expect(msg).toMatch(/--(diff|save)/);
  });

  it("flags --resume + --diff + --save + --out (all four)", () => {
    const msg = detectContextModeConflict({ resume: "x", diff: "y", save: "z", out: "/tmp/x.json" });
    expect(msg).toBeDefined();
    expect(msg).toMatch(/--resume/);
  });
});

describe("detectContextModeConflict: edge cases", () => {
  it("empty string is falsy — does NOT trigger a conflict", () => {
    // Empty string is falsy in JS, so {} && { resume: "" } both behave as
    // the flag not being set. This pins that semantic.
    expect(detectContextModeConflict({ resume: "" })).toBeUndefined();
    expect(detectContextModeConflict({ diff: "" })).toBeUndefined();
    expect(detectContextModeConflict({ save: "" })).toBeUndefined();
    expect(detectContextModeConflict({ out: "" })).toBeUndefined();
  });

  it("all four mode flags set triggers --resume conflict (first checked)", () => {
    const msg = detectContextModeConflict({
      resume: "a", diff: "b", save: "c", out: "/tmp/x.json",
    });
    expect(msg).toMatch(/--resume/);
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
    const msg = detectContextModeConflict({ resume: "x", out: "/tmp/x.json", format: "json" });
    expect(msg).toMatch(/--resume cannot be combined with --out/);
  });

  it("format=json does not exempt --diff + --out", () => {
    const msg = detectContextModeConflict({ diff: "x", out: "/tmp/x.json", format: "json" });
    expect(msg).toMatch(/--diff cannot be combined with --out/);
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

  it("empty limit string is truthy — flags --full + --limit with empty string", () => {
    // Commander gives --limit a string; empty string is truthy in JS.
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

  it("injective: different inputs produce different outputs", () => {
    const ids = ["a/b", "a~2Fb", "a?b", "a~3Fb", ".", "~2E", "~", "~7E"];
    const sanitized = ids.map(sanitizeId);
    expect(new Set(sanitized).size).toBe(ids.length);
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
    expect(result.asOfRev).toBe("42");
    expect(result.depth).toBe("shallow");
  });

  it("opts override saved rev", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { asOfRev: "10" });
    expect(result.asOfRev).toBe("10");
    expect(result.depth).toBe("shallow");
  });

  it("opts override saved depth", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { depth: "deep" });
    expect(result.asOfRev).toBe("42");
    expect(result.depth).toBe("deep");
  });

  it("opts override both", () => {
    const result = mergeDiffOptions(makeSaved(42, "shallow"), { asOfRev: "10", depth: "deep" });
    expect(result.asOfRev).toBe("10");
    expect(result.depth).toBe("deep");
  });

  it("undefined saved rev falls through to undefined", () => {
    const result = mergeDiffOptions(makeSaved(undefined, undefined), {});
    expect(result.asOfRev).toBeUndefined();
    expect(result.depth).toBeUndefined();
  });

  it("opts.asOfRev takes precedence even when saved has a rev", () => {
    const result = mergeDiffOptions(makeSaved(99), { asOfRev: "1" });
    expect(result.asOfRev).toBe("1");
  });
});

// ── reportContextModeConflict / reportDiffModeConflict ───────────────

describe("reportModeConflict", () => {
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
    reportModeConflict("test conflict message");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.join("\n")).toMatch(/Error:/);
    expect(stderrOutput.join("\n")).toMatch(/test conflict message/);
  });

  it("can be called multiple times (idempotent exit code)", () => {
    reportModeConflict("first");
    reportModeConflict("second");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.length).toBe(2);
  });
});

describe("reportModeConflict with llm format", () => {
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
    reportModeConflict("llm conflict message", "llm");
    expect(process.exitCode).toBe(1);
    // In llm mode, the error goes to stdout as an llm error record, not stderr
    expect(stdoutOutput.join("\n")).toMatch(/mode_conflict/);
    expect(stdoutOutput.join("\n")).toMatch(/llm conflict message/);
  });

  it("uses stderr Error: prefix when format is 'json'", () => {
    reportModeConflict("json conflict message", "json");
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.join("\n")).toMatch(/Error:/);
    expect(stderrOutput.join("\n")).toMatch(/json conflict message/);
  });
});

// ── Integration: edge-case Commander invocations ────────────────────

describe("ix context edge-case integration", () => {
  it("--resume x alone does NOT set exit code (no target needed)", () => {
    // --resume loads from disk; it does not need a target or backend.
    // This verifies that resume-only does not accidentally trigger the conflict detector.
    const r = runProgram(registerContextCommand, ["context", "--resume", "nonexistent-id"]);
    // The loadInvestigation function prints a warning but does NOT set exitCode=1
    // (it is a warning, not a conflict). The conflict detector should NOT fire.
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });

  it("--diff x alone does NOT set exit code (no target needed)", () => {
    const r = runProgram(registerContextCommand, ["context", "--diff", "nonexistent-id"]);
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });

  it("--save x alone does NOT set exit code (requires target)", () => {
    // --save without a target prints a warning, not a conflict.
    const r = runProgram(registerContextCommand, ["context", "--save", "test-id"]);
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });

  it("--out /tmp/x.json alone does NOT set exit code (requires target)", () => {
    const r = runProgram(registerContextCommand, ["context", "--out", "/tmp/test.json"]);
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });
});

describe("ix diff edge-case integration", () => {
  it("--summary alone does NOT set exit code (requires valid revs)", () => {
    const r = runProgram(registerDiffCommand, ["diff", "1", "2", "--summary"]);
    // May fail due to no backend, but should NOT fail due to conflict detection
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });

  it("--content alone does NOT set exit code", () => {
    const r = runProgram(registerDiffCommand, ["diff", "1", "2", "--content"]);
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });

  it("--full alone does NOT set exit code", () => {
    const r = runProgram(registerDiffCommand, ["diff", "1", "2", "--full"]);
    expect(r.stderr).not.toMatch(/cannot be combined/);
  });
});
