// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeBackend, SMALL_READ_GRAPH } from "./helpers/fake-backend.js";
import { runCommand, type RunCommandResult } from "./helpers/run-command.js";
import { llmQuote } from "../llm.js";

/**
 * Characterisation snapshots of what a plugin sees from `ix locate`,
 * `ix callers` and `ix impact`: stdout, stderr and the exit code, in every
 * `--format`, for the four outcomes a plugin routes on (outcome.ts):
 *
 *   resolved    `paint`, one entity                        exit 0
 *   ambiguous   `draw`, one per file: answered for the top
 *               candidate (exit 0), and with --strict      exit 2
 *   unknown     `vanish`, in no entity and no file          exit 3
 *   unmapped    run from a directory no workspace contains  exit 4
 *
 * They pin today's output so a refactor of how commands write output and set
 * their exit code (Ix#938) can prove it changed nothing. A snapshot that
 * changes is a plugin-facing change: update it only on purpose.
 *
 * Commands run in-process against FakeBackend's SMALL_READ_GRAPH through
 * `runCommand` (helpers/run-command.ts, which lists its limits: no Pro, no
 * rg/git on PATH, no TTY).
 *
 * Normalised, because they differ per run and per OS -- and nothing else:
 *   - the run's temp directory (scratch IX_HOME, workspace and unmapped
 *     directory all live under it), in any of the forms it is printed in
 *     (native, JSON-escaped, forward-slashed), becomes `<TMP>`, and the
 *     separators in the path after it become `/`; an llm value that is only
 *     such a path loses the quotes Windows' backslashes gave it;
 *   - the FakeBackend's port (in the endpoint, should one be printed) becomes
 *     `<PORT>`.
 * No duration is printed by any of these outputs today; if one appears, the
 * snapshot fails and the new value should be added here.
 */

const COMMANDS = ["locate", "callers", "impact"] as const;
const FORMATS = ["text", "json", "llm"] as const;

const backend = new FakeBackend();
backend.readGraph = SMALL_READ_GRAPH;

beforeAll(async () => {
  await backend.start();
});
afterAll(async () => {
  await backend.stop();
});
afterEach(() => {
  // Every route these commands call is one the fake implements.
  expect(backend.unknownPaths).toEqual([]);
  backend.unknownPaths.length = 0;
  backend.reads.length = 0;
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalise(text: string, run: RunCommandResult): string {
  const root = run.tempRoot;
  const forms = new Set([root, root.replace(/\\/g, "/"), JSON.stringify(root).slice(1, -1)]);
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    // The root, then the rest of the path: any run of path characters and separators.
    // A separator is `/`, `\`, or `\\` (a backslash JSON-escaped).
    const pattern = new RegExp(`${escapeRegExp(form)}((?:(?:\\\\\\\\|[\\\\/])[\\w.-]+)*)`, "g");
    out = out.replace(pattern, (_m, rest: string) => `<TMP>${rest.replace(/\\\\|\\/g, "/")}`);
  }
  // `--format llm` quotes a value holding a `\` (llm.ts), so on Windows a bare
  // path prints as dir="C:\\...". Once it is `<TMP>/...` it needs no quoting:
  // print it as it prints on POSIX.
  out = out.replace(/="(<TMP>(?:\/[\w.-]+)*)"/g, "=$1");
  return out.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>");
}

function render(argv: string[], run: RunCommandResult): string {
  return [
    `$ ix ${argv.join(" ")}`,
    `exit: ${run.exitCode}`,
    "--- stdout",
    normalise(run.stdout, run),
    "--- stderr",
    normalise(run.stderr, run),
  ].join("\n");
}

async function snapshotOf(
  command: string,
  format: string,
  args: string[],
  cwd: "workspace" | "unmapped" = "workspace",
): Promise<{ text: string; exitCode: number }> {
  const argv = [command, ...args, "--format", format];
  const run = await runCommand(argv, { backend, cwd, files: SMALL_READ_GRAPH.files });
  return { text: render(cwd === "unmapped" ? [...argv, "# from an unmapped directory"] : argv, run), exitCode: run.exitCode };
}

describe.each(COMMANDS)("ix %s: plugin-facing output", (command) => {
  describe.each(FORMATS)("--format %s", (format) => {
    it("resolved target", async () => {
      const { text, exitCode } = await snapshotOf(command, format, ["paint"]);
      expect(exitCode).toBe(0);
      expect(text).toMatchSnapshot();
    });

    it("ambiguous target (default, then --strict)", async () => {
      const answered = await snapshotOf(command, format, ["draw"]);
      const strict = await snapshotOf(command, format, ["draw", "--strict"]);
      expect(answered.exitCode).toBe(0);
      expect(strict.exitCode).toBe(2);
      expect(`${answered.text}\n\n${strict.text}`).toMatchSnapshot();
    });

    it("unknown target", async () => {
      const { text, exitCode } = await snapshotOf(command, format, ["vanish"]);
      expect(exitCode).toBe(3);
      expect(text).toMatchSnapshot();
    });

    it("unmapped workspace", async () => {
      const { text, exitCode } = await snapshotOf(command, format, ["paint"], "unmapped");
      expect(exitCode).toBe(4);
      expect(text).toMatchSnapshot();
    });
  });
});

describe("normalise", () => {
  // The snapshots are recorded on POSIX; this pins that a Windows run normalises to the same text.
  const posix = { stdout: "", stderr: "", exitCode: 4, tempRoot: "/tmp/ix-run-command-abc" };
  const windows = { ...posix, tempRoot: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ix-run-command-abc" };
  const llmLine = (root: string, sep: string) => {
    const dir = `${root}${sep}elsewhere`;
    return `error code=workspace_not_mapped message=${llmQuote(`${dir} is not mapped.`)} dir=${llmQuote(dir)} hint=${llmQuote(`Run \`ix map ${dir}\``)}`;
  };

  it("prints an llm path value the same on Windows as on POSIX", () => {
    const expected = 'error code=workspace_not_mapped message="<TMP>/elsewhere is not mapped." dir=<TMP>/elsewhere hint="Run `ix map <TMP>/elsewhere`"';
    expect(normalise(llmLine(posix.tempRoot, "/"), posix)).toBe(expected);
    expect(normalise(llmLine(windows.tempRoot, "\\"), windows)).toBe(expected);
  });

  it("keeps the quotes on a value that is more than the path", () => {
    const text = `note=${llmQuote(`${windows.tempRoot}\\a b`)}`;
    expect(normalise(text, windows)).toBe('note="<TMP>/a b"');
  });
});
