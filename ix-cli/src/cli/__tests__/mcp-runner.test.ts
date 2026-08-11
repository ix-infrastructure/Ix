import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { createInProcessRunner, resolveDefaultRunner, runCurrentIx } from "../../mcp/runner.js";

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

  return program;
}

function testRunner() {
  return createInProcessRunner({ version: "test-version", createProgram: createTestProgram });
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

    const result = await run(["slow"], 50);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("timed out after 50ms");
  });

  it("stays usable after a timeout rather than stranding the queue", async () => {
    const run = testRunner();

    await run(["slow"], 50);

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
