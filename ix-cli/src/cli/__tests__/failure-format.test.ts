// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One failure shape per format, whichever command failed and however.
 *
 * Commands used to report failures three ways: throw to the top-level handler,
 * print their own text, or print a usage refusal as prose whatever `--format`
 * was. `reportFailure` had no json branch, so three commands kept private
 * copies that did, and `ix stats --format json` answered a backend failure with
 * an empty stdout. Each row here is one failure kind; each is checked in every
 * format for its stdout shape and its exit code (outcome.ts).
 */

// ── The backend, faked ────────────────────────────────────────────────────

const client = {
  stats: vi.fn(),
  listSubsystems: vi.fn(),
  scoreSubsystems: vi.fn(),
  getSubsystemMap: vi.fn(),
};

vi.mock("../../client/factory.js", () => ({ createClient: () => client }));
vi.mock("../resolve.js", async (orig) => ({
  ...(await orig<typeof import("../resolve.js")>()),
  resolveReadSystemId: async () => undefined,
}));
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));
vi.mock("../map-freshness.js", async (orig) => ({
  ...(await orig<typeof import("../map-freshness.js")>()),
  ensureFreshMapState: async () => ({ stale: false }),
}));

const { reportFailure } = await import("../ui.js");
const { renderCliError, setErrorFormat } = await import("../errors.js");
const { exitCodeFor } = await import("../outcome.js");
const { registerStatsCommand } = await import("../commands/stats.js");
const { registerSubsystemsCommand } = await import("../commands/subsystems.js");
const { registerAroundCommand } = await import("../commands/around.js");
const { registerReadCommand } = await import("../commands/read.js");
const { registerOverridesCommand } = await import("../commands/overrides.js");

// ── Capture ───────────────────────────────────────────────────────────────

interface Captured { out: string; err: string; exitCode: number }

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

function currentExit(): number {
  const code = process.exitCode;
  return code === undefined || code === null || code === "" ? 0 : Number(code);
}

/**
 * Run `fn` as `run-cli.ts` would: whatever it throws goes to `renderCliError`
 * with the command's format recorded, and `process.exit` is caught.
 */
async function capture(format: string, fn: () => void | Promise<void>): Promise<Captured> {
  let out = "";
  let err = "";
  let exited: number | undefined;
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out += args.map(String).join(" ") + "\n"; }),
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err += args.map(String).join(" ") + "\n"; }),
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { err += args.map(String).join(" ") + "\n"; }),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out += String(chunk); return true; }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err += String(chunk); return true; }),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never),
  ];
  try {
    try {
      await fn();
    } catch (thrown) {
      if (thrown instanceof ExitSignal) throw thrown;
      setErrorFormat(format);
      renderCliError(thrown, false, "http://localhost:8090");
    }
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    exited = thrown.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
    setErrorFormat(undefined);
  }
  return { out, err, exitCode: exited ?? currentExit() };
}

const FORMATS = ["text", "json", "llm"] as const;
type Format = typeof FORMATS[number];

/** The one shape every failure has in `format`. */
function expectFailureShape(format: Format, { out, err, exitCode }: Captured, code: string, exit: number): void {
  expect(exitCode).toBe(exit);
  if (format === "json") {
    const record = JSON.parse(out);
    expect(record).toEqual(expect.objectContaining({ error: code }));
    expect(typeof record.message).toBe("string");
    expect(record.message.length).toBeGreaterThan(0);
    // The prose stays on stderr, as the top-level handler keeps it for json.
    expect(err).toContain(record.message);
  } else if (format === "llm") {
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^error code=${code} message=`));
    expect(err).toBe("");
  } else {
    expect(out).toBe("");
    expect(err.trim().length).toBeGreaterThan(0);
  }
}

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  for (const fn of Object.values(client)) fn.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

// ── The helper ────────────────────────────────────────────────────────────

const HELPER_CASES: Array<{ code: string; exit: () => number }> = [
  { code: "mode_conflict", exit: () => 1 },
  { code: "invalid_line_range", exit: () => 1 },
  { code: "unresolved_target", exit: () => exitCodeFor("not_found") },
  { code: "ambiguous_target", exit: () => exitCodeFor("ambiguous") },
  { code: "workspace_not_mapped", exit: () => exitCodeFor("not_mapped") },
];

describe("reportFailure: failure kind x format", () => {
  for (const { code, exit } of HELPER_CASES) {
    for (const format of FORMATS) {
      it(`${code} · ${format}`, async () => {
        const captured = await capture(format, () => reportFailure(code, `${code} happened`, format));
        expectFailureShape(format, captured, code, exit());
      });
    }
  }

  it("carries extra fields in json and llm", async () => {
    const json = await capture("json", () => reportFailure("unresolved_target", "gone", "json", [["reason", "file_not_in_graph"]]));
    expect(JSON.parse(json.out)).toEqual({ error: "unresolved_target", message: "gone", reason: "file_not_in_graph" });
    const llm = await capture("llm", () => reportFailure("unresolved_target", "gone", "llm", [["reason", "file_not_in_graph"]]));
    expect(llm.out).toContain("reason=file_not_in_graph");
  });

  it("IX_LEGACY_EXIT_CODES=1 collapses a miss to 1", async () => {
    vi.stubEnv("IX_LEGACY_EXIT_CODES", "1");
    try {
      const captured = await capture("json", () => reportFailure("unresolved_target", "gone", "json"));
      expect(captured.exitCode).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── The commands ──────────────────────────────────────────────────────────

function unreachable(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8090"), { code: "ECONNREFUSED" });
  return err;
}

async function run(register: (program: Command) => void, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(argv, { from: "user" });
}

const COMMAND_CASES: Array<{
  name: string;
  register: (program: Command) => void;
  argv: string[];
  arm?: () => void;
  code: string;
}> = [
  {
    name: "stats · backend unreachable", register: registerStatsCommand, argv: ["stats"],
    arm: () => client.stats.mockRejectedValue(unreachable()), code: "backend_unreachable",
  },
  {
    name: "stats · backend structured error", register: registerStatsCommand, argv: ["stats"],
    arm: () => client.stats.mockRejectedValue(new Error('503: {"error":"graph_busy","message":"Graph is busy","next":"Retry shortly"}')),
    code: "graph_busy",
  },
  { name: "subsystems · --list --limit 5", register: registerSubsystemsCommand, argv: ["subsystems", "--list", "--limit", "5"], code: "usage_error" },
  { name: "subsystems · --list with a target", register: registerSubsystemsCommand, argv: ["subsystems", "api", "--list"], code: "usage_error" },
  { name: "subsystems · --list --explain", register: registerSubsystemsCommand, argv: ["subsystems", "--list", "--explain"], code: "usage_error" },
  { name: "subsystems · --detailed without --list", register: registerSubsystemsCommand, argv: ["subsystems", "--detailed"], code: "usage_error" },
  { name: "subsystems · --pick without a target", register: registerSubsystemsCommand, argv: ["subsystems", "--pick", "2"], code: "usage_error" },
  { name: "subsystems · --explain without a target", register: registerSubsystemsCommand, argv: ["subsystems", "--explain"], code: "usage_error" },
  {
    name: "subsystems · --list, backend unreachable", register: registerSubsystemsCommand, argv: ["subsystems", "--list"],
    arm: () => client.listSubsystems.mockRejectedValue(unreachable()), code: "backend_unreachable",
  },
  {
    name: "subsystems · map, backend unreachable", register: registerSubsystemsCommand, argv: ["subsystems"],
    arm: () => client.getSubsystemMap.mockRejectedValue(unreachable()), code: "backend_unreachable",
  },
  { name: "around · invalid target", register: registerAroundCommand, argv: ["around", "src/a.ts:0"], code: "invalid_line_range" },
  { name: "read · invalid line range", register: registerReadCommand, argv: ["read", "src/a.ts:9-3"], code: "invalid_line_range" },
  { name: "read · page outside its range", register: registerReadCommand, argv: ["read", "src/a.ts:3-9@20"], code: "invalid_line_range" },
  { name: "overrides · invalid --limit", register: registerOverridesCommand, argv: ["overrides", "handle", "--limit", "abc"], code: "invalid_limit" },
];

describe("graph commands: failure kind x format", () => {
  for (const c of COMMAND_CASES) {
    for (const format of FORMATS) {
      it(`${c.name} · ${format}`, async () => {
        c.arm?.();
        const captured = await capture(format, () => run(c.register, [...c.argv, "--format", format]));
        expectFailureShape(format, captured, c.code, 1);
      });
    }
  }
});
