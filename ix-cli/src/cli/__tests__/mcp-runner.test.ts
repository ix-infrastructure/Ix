import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireMapLock, lockPathForTest } from "../single-flight.js";
import { createInProcessRunner, resolveDefaultRunner, runCurrentIx } from "../../mcp/runner.js";

const resetReadScope = vi.hoisted(() => vi.fn());
vi.mock("../resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve.js")>()),
  resetReadScope,
}));

/**
 * A stand-in command tree. The capture machinery is what is under test here,
 * not the Ix commands, and a real one would need a backend.
 */
function createTestProgram(): Command {
  const program = new Command();
  program.name("ix").version("test-version").exitOverride();

  program
    .command("say")
    .argument("<text>")
    .option("--path <path>", "optional scope")
    .action((text: string, opts: { path?: string }) => {
      console.log(`out:${text}${opts.path ? ` path:${opts.path}` : ""}`);
    });

  program
    .command("boom")
    .action(() => {
      console.error("fatal detail");
      // The shape `ix status` and `ix text` use on their error paths.
      process.exit(1);
    });

  program
    .command("soft-fail")
    .action(() => {
      console.log("error code=backend_error message=offline");
      // The shape most commands use: report on stdout, flag via exitCode.
      process.exitCode = 1;
    });

  program
    .command("slow")
    .option("--delay <ms>", "how long to run past the caller's patience", "5000")
    .option("--tag <tag>", "marker identifying which invocation printed", "slow")
    .action(async (opts: { delay: string; tag: string }) => {
      await new Promise((resolve) => setTimeout(resolve, Number(opts.delay)));
      console.log(`done:${opts.tag}`);
    });

  program
    .command("flood")
    .action(() => {
      for (let i = 0; i < 20; i += 1) console.log("x".repeat(100));
    });

  // A command that outlives its timeout and *then* reports failure the way
  // `ix map` does — the shape that used to be charged to whichever call was
  // running by the time it landed.
  program
    .command("late-fail")
    .option("--delay <ms>", "how long before it reports failure", "150")
    .action(async (opts: { delay: string }) => {
      await new Promise((resolve) => setTimeout(resolve, Number(opts.delay)));
      process.exitCode = 1;
    });

  // Stands in for `ix map`, which takes a single-flight lock and leaves it to
  // process exit to release.
  program
    .command("map")
    .option("--hold <ms>", "keep working after taking the lock", "0")
    .action(async (opts: { hold: string }) => {
      const workspace = process.env.IX_TEST_WORKSPACE ?? "workspace";
      const lock = acquireMapLock(workspace, "ix map test");
      if (!lock) {
        console.log("coalesced");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Number(opts.hold)));
      // Whether the lock this command took is still its own by the time it
      // finishes — anything releasing it mid-run reopens the window.
      console.log(existsSync(lockPathForTest(workspace)) ? "mapped" : "lock-taken-mid-run");
    });

  program.command("ingest").action(() => console.log("ingested"));

  // Never settles: a hung backend call, or a rejection that used to end the
  // process and is now only logged by the server's error handlers.
  program.command("hang").action(async () => {
    await new Promise(() => {});
  });

  return program;
}

function testRunner() {
  return createInProcessRunner({ version: "test-version", createProgram: createTestProgram });
}

/**
 * Run a body against a throwaway lock directory.
 *
 * Any test whose commands reach `acquireMapLock` needs this: without it the
 * lock lands in the developer's real `~/.ix/locks` and can block their own
 * `ix map` for twenty minutes.
 */
async function withLockDir(body: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ix-mcp-lock-"));
  const previous = { lockDir: process.env.IX_LOCK_DIR, workspace: process.env.IX_TEST_WORKSPACE };
  process.env.IX_LOCK_DIR = dir;
  process.env.IX_TEST_WORKSPACE = join(dir, "workspace");
  try {
    await body();
  } finally {
    if (previous.lockDir === undefined) delete process.env.IX_LOCK_DIR;
    else process.env.IX_LOCK_DIR = previous.lockDir;
    if (previous.workspace === undefined) delete process.env.IX_TEST_WORKSPACE;
    else process.env.IX_TEST_WORKSPACE = previous.workspace;
    rmSync(dir, { recursive: true, force: true });
  }
}

const originalSubprocessFlag = process.env.IX_MCP_SUBPROCESS;

afterEach(() => {
  if (originalSubprocessFlag === undefined) delete process.env.IX_MCP_SUBPROCESS;
  else process.env.IX_MCP_SUBPROCESS = originalSubprocessFlag;
});

describe("in-process ix runner", () => {
  it("captures command stdout instead of writing it to the process", async () => {
    const run = testRunner();

    const result = await run(["say", "hello"]);

    expect(result).toEqual({ ok: true, stdout: "out:hello\n", stderr: "" });
  });

  it("turns a command's process.exit into a failed result without exiting", async () => {
    const run = testRunner();

    const result = await run(["boom"]);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("fatal detail");
    // Reaching this line at all is the assertion that matters: a real
    // process.exit here would have taken the MCP server down.
    expect(await run(["say", "still alive"])).toMatchObject({ ok: true });
  });

  it("reports process.exitCode failures and leaves the host exit code alone", async () => {
    const run = testRunner();
    process.exitCode = undefined;

    const result = await run(["soft-fail"]);

    expect(result.ok).toBe(false);
    expect(result.stdout).toBe("error code=backend_error message=offline\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not leak option values from one run into the next", async () => {
    const run = testRunner();

    const scoped = await run(["say", "a", "--path", "src/mcp"]);
    const unscoped = await run(["say", "b"]);

    expect(scoped.stdout).toBe("out:a path:src/mcp\n");
    // Commander keeps parsed values on the Command object, so a cached program
    // would answer "out:b path:src/mcp" here.
    expect(unscoped.stdout).toBe("out:b\n");
  });

  it("keeps concurrent calls' output and exit status separate", async () => {
    const run = testRunner();

    const [first, second, third] = await Promise.all([
      run(["say", "one"]),
      run(["soft-fail"]),
      run(["say", "three"]),
    ]);

    expect(first).toEqual({ ok: true, stdout: "out:one\n", stderr: "" });
    expect(second.ok).toBe(false);
    expect(third).toEqual({ ok: true, stdout: "out:three\n", stderr: "" });
  });

  it("fails a run that outlives its timeout", async () => {
    const run = testRunner();

    // Bounded rather than left on the 5s default: an abandoned command stays
    // in flight after the test that started it, and while one is alive the
    // runner distrusts process.exitCode and holds off releasing locks — so a
    // long orphan silently changes what later tests in this file observe.
    const result = await run(["slow", "--delay", "200"], 50);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("timed out after 50ms");
  });

  it("stays usable after a timeout rather than stranding the queue", async () => {
    const run = testRunner();

    await run(["slow", "--delay", "200"], 50);

    expect(await run(["say", "after"])).toMatchObject({ ok: true, stdout: "out:after\n" });
  });

  it("keeps a timed-out command's late output out of the next call's result", async () => {
    const run = testRunner();

    // Abandoned at 50ms but still printing at ~150ms.
    const timedOut = await run(["slow", "--delay", "150", "--tag", "orphan"], 50);
    // Starts once the queue advances (~50ms) and is still running at ~150ms,
    // so it is the call the orphan's write would otherwise be misfiled into.
    const covering = await run(["slow", "--delay", "250", "--tag", "covering"], 5_000);

    expect(timedOut.ok).toBe(false);
    expect(covering).toEqual({ ok: true, stdout: "done:covering\n", stderr: "" });
  });

  it("does not charge a timed-out command's late exit code to the next call", async () => {
    const run = testRunner();
    process.exitCode = undefined;

    // Abandoned at 50ms; sets process.exitCode = 1 at ~150ms.
    const timedOut = await run(["late-fail", "--delay", "150"], 50);
    // Runs across that moment. Its own command succeeds.
    const covering = await run(["slow", "--delay", "250", "--tag", "covering"], 5_000);

    expect(timedOut.ok).toBe(false);
    // The orphan's write is the only thing that could make this false, and a
    // successful lookup reported as a failure hides its answer inside an
    // `error` string the agent cannot tell from a real fault.
    expect(covering).toEqual({ ok: true, stdout: "done:covering\n", stderr: "" });
    expect(process.exitCode).toBeUndefined();
  });

  it("trusts process.exitCode again once no orphan is in flight", async () => {
    const run = testRunner();
    process.exitCode = undefined;

    await run(["late-fail", "--delay", "60"], 30);
    // Long enough for the orphan to finish and leave the set.
    await run(["slow", "--delay", "150", "--tag", "drain"], 5_000);

    // Distrust must be temporary: a genuinely failing command still fails.
    expect(await run(["soft-fail"])).toMatchObject({ ok: false });
  });

  it("releases the map single-flight lock when the command ends, not the process", async () => {
    await withLockDir(async () => {
      const run = testRunner();

      const first = await run(["map"]);
      const second = await run(["map"]);

      expect(first.stdout).toBe("mapped\n");
      // The lock records the server's own live PID, so it never ages out as
      // stale. Held across calls, every later ix_map coalesced into an empty
      // success while the graph was never refreshed.
      expect(second.stdout).toBe("mapped\n");
    });
  });

  it("does not release a running command's lock when an orphan settles", async () => {
    await withLockDir(async () => {
      const run = testRunner();

      // Abandoned at 40ms, settles at ~150ms — part-way through the map below.
      const orphan = run(["slow", "--delay", "150", "--tag", "orphan"], 40);
      const mapped = run(["map", "--hold", "400"]);

      expect((await orphan).ok).toBe(false);
      // releaseHeldLocks drops *every* lock this process holds, not the
      // finishing command's, so an orphan settling mid-map deleted the lock of
      // the map that was still running — reopening the exact window
      // single-flight exists to close.
      expect((await mapped).stdout).toBe("mapped\n");
    });
  });

  it("stops distrusting the exit code once an abandoned command overruns its grace", async () => {
    await withLockDir(async () => {
      const run = createInProcessRunner({
        version: "test-version",
        createProgram: createTestProgram,
        orphanGraceMs: 60,
      });
      process.exitCode = undefined;

      // Never settles, so nothing will ever remove it from the orphan set.
      // Left unbounded, every later failure reports ok and no lock is ever
      // released again — both for the life of the server.
      await run(["hang"], 30);
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(await run(["soft-fail"], 30)).toMatchObject({ ok: false });
      expect((await run(["map"], 30)).stdout).toBe("mapped\n");
      expect((await run(["map"], 30)).stdout).toBe("mapped\n");
    });
  });

  it("invalidates the read-scope cache after a command that can change it", async () => {
    await withLockDir(async () => {
      const run = testRunner();
      resetReadScope.mockClear();

      await run(["say", "read"]);
      expect(resetReadScope).not.toHaveBeenCalled();

      // `ix map` can stitch the repo into a System server-side; every later read
      // in the session would otherwise still scope to the pre-map workspace.
      await run(["map"]);
      await run(["ingest"]);
      expect(resetReadScope).toHaveBeenCalledTimes(2);
    });
  });

  it("truncates output instead of growing the server heap without bound", async () => {
    const run = createInProcessRunner({
      createProgram: createTestProgram,
      maxOutputBytes: 500,
    });

    const result = await run(["flood"]);

    expect(result.stdout.length).toBeLessThanOrEqual(500);
    expect(result.stderr).toContain("exceeded 500 bytes and was truncated");
  });

  it("reports an unknown command as a failure with commander's message", async () => {
    const run = testRunner();

    const result = await run(["not-a-command"]);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not-a-command");
  });

  it("treats --version as a success rather than a usage error", async () => {
    const run = testRunner();

    const result = await run(["--version"]);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("test-version");
  });
});

describe("installServerErrorHandlers", () => {
  it("replaces the CLI's exit-on-error handlers with reporting ones", async () => {
    const { installServerErrorHandlers } = await import("../../mcp/runner.js");
    const before = {
      uncaught: process.listeners("uncaughtException"),
      unhandled: process.listeners("unhandledRejection"),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      installServerErrorHandlers();
      const handler = process.listeners("uncaughtException").at(-1) as (err: unknown) => void;
      handler(new Error("stray rejection from a fire-and-forget fetch"));

      // main.ts's handlers end in process.exit(1) on every path. For a server
      // that is the whole session and all 22 tools, over an error that belonged
      // to one tool call.
      expect(exit).not.toHaveBeenCalled();
      // And they are gone, not merely outnumbered: one handler each, ours.
      expect(process.listeners("uncaughtException")).toHaveLength(1);
      expect(process.listeners("unhandledRejection")).toHaveLength(1);
    } finally {
      exit.mockRestore();
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      for (const listener of before.uncaught) process.on("uncaughtException", listener);
      for (const listener of before.unhandled) process.on("unhandledRejection", listener);
    }
  });
});

describe("resolveDefaultRunner", () => {
  it("runs in-process by default", () => {
    delete process.env.IX_MCP_SUBPROCESS;

    expect(resolveDefaultRunner({ createProgram: createTestProgram })).not.toBe(runCurrentIx);
  });

  it("falls back to the child process when IX_MCP_SUBPROCESS=1", () => {
    process.env.IX_MCP_SUBPROCESS = "1";

    expect(resolveDefaultRunner({ createProgram: createTestProgram })).toBe(runCurrentIx);
  });
});
