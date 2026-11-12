// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "./fake-backend.js";
import { runCommand } from "./run-command.js";

/**
 * The shared command runner: it reports what the CLI's own boundary would
 * (stdout, stderr, exit code) and leaves the process as it found it, so one
 * test's run cannot leak into the next.
 */

let backend: FakeBackend;
let dir: string;

beforeAll(async () => {
  backend = new FakeBackend({ semantics: "head" });
  await backend.start();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ix-run-command-")));
});

afterAll(async () => {
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("help is a success: exit 0, usage on stdout", async () => {
    const { stdout, exitCode } = await runCommand(["verify", "--help"], backend);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Usage: ix verify/);
  });

  it("an unknown option is a usage error: exit 1, and an llm record when llm was asked for", async () => {
    const text = await runCommand(["verify", "--no-such-flag"], backend);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toMatch(/unknown option '--no-such-flag'/);

    const llm = await runCommand(["verify", "--no-such-flag", "--format", "llm"], backend);
    expect(llm.exitCode).toBe(1);
    expect(llm.stdout).toMatch(/^error code=usage_error message=.*--no-such-flag/m);
  });

  it("an unknown command is a usage error, not a silent success", async () => {
    const { stderr, exitCode } = await runCommand(["no-such-command"], backend);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });

  it("restores the process: exit code, env, cwd, stdout, console and process.exit", async () => {
    const before = {
      cwd: process.cwd(),
      endpoint: process.env.IX_ENDPOINT,
      write: process.stdout.write,
      errWrite: process.stderr.write,
      log: console.log,
      exit: process.exit,
    };
    process.env.IX_RUN_COMMAND_PROBE = "kept";
    process.exitCode = 7;
    try {
      const { exitCode } = await runCommand(["verify", "--no-such-flag"], backend, {
        cwd: dir,
        env: { IX_RUN_COMMAND_PROBE: undefined, IX_FORMAT: "llm" },
      });
      expect(exitCode).toBe(1);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = undefined;
    }
    expect(process.cwd()).toBe(before.cwd);
    expect(process.env.IX_ENDPOINT).toBe(before.endpoint);
    expect(process.env.IX_RUN_COMMAND_PROBE).toBe("kept");
    expect(process.env.IX_FORMAT).toBeUndefined();
    expect(process.stdout.write).toBe(before.write);
    expect(process.stderr.write).toBe(before.errWrite);
    expect(console.log).toBe(before.log);
    expect(process.exit).toBe(before.exit);
    delete process.env.IX_RUN_COMMAND_PROBE;
  });

  it("a run does not inherit the previous run's error format", async () => {
    await runCommand(["verify", "--no-such-flag", "--format", "llm"], backend);
    const { stdout, stderr } = await runCommand(["verify", "--no-such-flag"], backend);
    expect(stdout).not.toMatch(/^error code=/m);
    expect(stderr).toMatch(/unknown option/);
  });

  it("refuses a FakeBackend that was never started", async () => {
    await expect(runCommand(["verify"], new FakeBackend())).rejects.toThrow(/before start\(\)/);
  });
});
