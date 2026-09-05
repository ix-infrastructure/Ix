/**
 * diff-unresolved-target.test.ts — Ix #566
 *
 * `ix diff` was the one command that resolves a target and did not emit the
 * shared `unresolved_target` record. Its `--format json` branch put the human
 * sentence in the `error` field, where every other command puts the machine
 * slug, and `docs/llm-format.md` says a target that does not exist is always
 * `unresolved_target`.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search() { return []; }
  },
}));

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { registerDiffCommand } = await import("../commands/diff.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerDiffCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => stdout.push(parts.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("ix diff — unresolved target", () => {
  let savedExitCode: number | string | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("emits the shared slug and message as json for a symbol target", async () => {
    const result = await run(["diff", "3", "5", "DefinitelyMissing", "--format", "json"]);

    expect(JSON.parse(result.stdout)).toEqual({
      error: "unresolved_target",
      message: 'No entity found matching "DefinitelyMissing".',
    });
  });

  it("emits the shared slug and message as json for a file-like target", async () => {
    const result = await run(["diff", "3", "5", "DefinitelyMissing.ts", "--format", "json"]);

    expect(JSON.parse(result.stdout)).toEqual({
      error: "unresolved_target",
      message: 'No entity found matching "DefinitelyMissing.ts".',
    });
  });

  it("emits an llm error record with the same wording as every other command", async () => {
    const result = await run(["diff", "3", "5", "DefinitelyMissing", "--format", "llm"]);

    expect(result.stdout).toBe(
      'error code=unresolved_target message="No entity found matching \\"DefinitelyMissing\\"."',
    );
  });

  it("exits non-zero for an unresolved target", async () => {
    await run(["diff", "3", "5", "DefinitelyMissing", "--format", "json"]);

    expect(process.exitCode).toBe(1);
  });
});
