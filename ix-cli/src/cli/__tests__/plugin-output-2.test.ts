// Copyright 2026 Ix Infrastructure Inc.

import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeBackend, SMALL_READ_GRAPH } from "./helpers/fake-backend.js";
import { runCommand, type RunCommandResult } from "./helpers/run-command.js";
import { normalise } from "./helpers/normalise-output.js";

/**
 * Characterisation snapshots of what a plugin sees from `ix status`,
 * `ix inventory` and `ix overview`, and from `ix callers` given two targets:
 * stdout, stderr and the exit code. The second batch of the set
 * plugin-output.test.ts starts (Ix#938), and the same rules apply: a snapshot
 * that changes is a plugin-facing change, so update it only on purpose.
 *
 * status, inventory and overview run in every `--format`, in three states:
 *
 *   healthy       the FakeBackend serves SMALL_READ_GRAPH, run from the workspace
 *   backend down  IX_ENDPOINT is a loopback port nothing listens on, so the
 *                 connection is refused (not port 1: Node's fetch refuses to
 *                 dial it at all, "bad port", which is not a backend that is down)
 *   unmapped      run from a directory no workspace contains
 *
 * `ix callers paint vanish` runs in json and llm: one target found, one
 * missing. That is multi-target.ts's path: json captures each target's answer
 * (`captureJson`) into one object, and the process exits with the worst
 * target's code (here 3, unresolved).
 *
 * Commands run in-process through `runCommand` (helpers/run-command.ts, which
 * lists its limits: no Pro, no rg/git on PATH, no TTY). Output is normalised by
 * helpers/normalise-output.ts: the run's temp directory becomes `<TMP>` and the
 * FakeBackend's port `<PORT>`; the down endpoint's port, which is also picked
 * per run, becomes `<DOWN_PORT>`. No duration is printed by any of these
 * outputs today; if one appears, the snapshot fails and the new value should
 * be normalised.
 */

const FORMATS = ["text", "json", "llm"] as const;

const backend = new FakeBackend();
backend.readGraph = SMALL_READ_GRAPH;
let backendPort = "";
/** A loopback endpoint nothing listens on: connecting is refused at once. */
let downEndpoint = "";
let downPort = "";

/** A port that was free a moment ago: bind it, note it, release it. */
async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  backendPort = new URL(await backend.start()).port;
  downPort = String(await closedLoopbackPort());
  downEndpoint = `http://127.0.0.1:${downPort}`;
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

type State = "healthy" | "backend down" | "unmapped";
const STATES: State[] = ["healthy", "backend down", "unmapped"];

function render(argv: string[], state: State, run: RunCommandResult): string {
  const note = state === "backend down" ? " # IX_ENDPOINT=http://127.0.0.1:<DOWN_PORT>, nothing listening"
    : state === "unmapped" ? " # from an unmapped directory"
      : "";
  const clean = (text: string): string => normalise(text, run, { port: backendPort })
    .replace(new RegExp(`127\\.0\\.0\\.1:${downPort}(?!\\d)`, "g"), "127.0.0.1:<DOWN_PORT>");
  return [
    `$ ix ${argv.join(" ")}${note}`,
    `exit: ${run.exitCode}`,
    "--- stdout",
    clean(run.stdout),
    "--- stderr",
    clean(run.stderr),
  ].join("\n");
}

async function snapshotOf(argv: string[], state: State = "healthy"): Promise<{ text: string; exitCode: number }> {
  const run = await runCommand(argv, {
    backend,
    files: SMALL_READ_GRAPH.files,
    cwd: state === "unmapped" ? "unmapped" : "workspace",
    env: state === "backend down" ? { IX_ENDPOINT: downEndpoint } : undefined,
  });
  return { text: render(argv, state, run), exitCode: run.exitCode };
}

/**
 * Each command, its arguments, and the exit code a plugin gets in each state.
 * `ix status` reads no workspace's graph, so an unmapped directory is not an
 * error for it: it answers as it does from the workspace, and exits 0.
 */
const COMMANDS: Array<{ command: string; args: string[]; exit: Record<State, number> }> = [
  { command: "status", args: [], exit: { "healthy": 0, "backend down": 1, "unmapped": 0 } },
  { command: "inventory", args: ["--kind", "function"], exit: { "healthy": 0, "backend down": 1, "unmapped": 4 } },
  { command: "overview", args: ["paint"], exit: { "healthy": 0, "backend down": 1, "unmapped": 4 } },
];

describe.each(COMMANDS.map((c) => [c.command, c] as const))("ix %s: plugin-facing output", (_name, { command, args, exit }) => {
  describe.each(FORMATS)("--format %s", (format) => {
    it.each(STATES)("%s", async (state) => {
      const { text, exitCode } = await snapshotOf([command, ...args, "--format", format], state);
      expect(exitCode).toBe(exit[state]);
      expect(text).toMatchSnapshot();
    });
  });
});

describe("ix callers with two targets, one found and one missing: plugin-facing output", () => {
  it.each(["json", "llm"] as const)("--format %s", async (format) => {
    const { text, exitCode } = await snapshotOf(["callers", "paint", "vanish", "--format", format]);
    // The worst target's code: vanish is unresolved (3), paint answered (0).
    expect(exitCode).toBe(3);
    expect(text).toMatchSnapshot();
  });
});

describe("normalise with a port", () => {
  const run = { tempRoot: "/tmp/ix-run-command-abc" };

  it("replaces only that port, so another endpoint keeps its own", () => {
    const text = "at http://127.0.0.1:4100 and http://127.0.0.1:41000 and http://127.0.0.1:1";
    expect(normalise(text, run, { port: "4100" }))
      .toBe("at http://127.0.0.1:<PORT> and http://127.0.0.1:41000 and http://127.0.0.1:1");
    expect(normalise(text, run)).toBe("at http://127.0.0.1:<PORT> and http://127.0.0.1:<PORT> and http://127.0.0.1:<PORT>");
  });
});
