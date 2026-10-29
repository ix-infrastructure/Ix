// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeClient = {
  runSmells: vi.fn(),
  listSmells: vi.fn(),
};

vi.mock("../../client/factory.js", () => ({ createClient: () => fakeClient }));
vi.mock("../resolve.js", () => ({ resolveReadSystemId: async () => undefined }));
vi.mock("../bootstrap.js", () => ({ resolveWorkspaceId: () => "ws-test" }));

import { registerSmellsCommand, type SmellReport } from "../commands/smells.js";

/** What fetch rejects with when `AbortSignal.timeout` fires. */
function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** A backend that never answers: the request fails when the client's own timeout fires. */
function neverAnswers() {
  return (opts: { timeoutMs?: number }) =>
    new Promise((_resolve, reject) => setTimeout(() => reject(timeoutError()), opts.timeoutMs ?? 120_000));
}

/**
 * What Node's fetch (undici) rejects with when the response headers have not
 * arrived after its default 300 s headersTimeout: not a `TimeoutError`.
 */
function headersTimeoutError(): Error {
  const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  return new TypeError("fetch failed", { cause });
}

/** A backend that has sent nothing when undici's 300 s headersTimeout fires, before the request's own timeout. */
function headersTimeoutAt300s() {
  return () => new Promise((_resolve, reject) => setTimeout(() => reject(headersTimeoutError()), 300_000));
}

/** A backend that answers after `ms`. */
function answersAfter(ms: number, value: SmellReport) {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const REPORT: SmellReport = {
  rev: 7,
  run_at: "2026-10-11T00:00:00Z",
  count: 3,
  candidates: [
    { file_id: "f1", file: "src/a.ts", smell: "has_smell.orphan_file", confidence: 0.5, signals: { connectivity: 0 }, inference_version: "smell_v1" },
    { file_id: "f2", file: "src/big.ts", smell: "has_smell.god_module", confidence: 0.9, signals: { chunks: 42, fan_in: 18, fan_out: 9 }, inference_version: "smell_v1" },
    { file_id: "f3", file: "README.md", smell: "has_smell.orphan_file", confidence: 0.8, signals: { connectivity: 0 }, inference_version: "smell_v1" },
  ],
};

/**
 * `GET /v1/smells` as the backend answers it: confidence, file and signals
 * live under `value`. Today's backend puts no `rev`/`run_at` on a row; these
 * rows carry them to show that they are read when present.
 */
const STORED = {
  smells: [
    { smell: "has_smell.orphan_file", entity_id: "entity-a-0123456789", value: { confidence: 0.4, file: "src/a.ts", signals: { connectivity: 0 } }, inference_version: "smell_v1", rev: 11, run_at: "2026-10-20T08:00:00Z" },
    { smell: "has_smell.god_module", entity_id: "entity-b-0123456789", value: { confidence: 0.9, file: "src/big.ts", signals: { chunks: 42, fan_in: 18, fan_out: 9 } }, inference_version: "smell_v1", rev: 12, run_at: "2026-10-21T09:30:00Z" },
  ],
  total: 2,
  truncated: false,
};

describe("ix smells wait budget and stored-results fallback", () => {
  let logs: string[];
  let errs: string[];
  let stderr: string[];
  let savedTty: boolean | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    logs = [];
    errs = [];
    stderr = [];
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errs.push(args.map(String).join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    fakeClient.runSmells.mockReset();
    fakeClient.listSmells.mockReset().mockResolvedValue(STORED);
    savedTty = process.stderr.isTTY;
    savedEnv = process.env.IX_SMELLS_WAIT;
    delete process.env.IX_SMELLS_WAIT;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    process.stderr.isTTY = savedTty as boolean;
    if (savedEnv === undefined) delete process.env.IX_SMELLS_WAIT;
    else process.env.IX_SMELLS_WAIT = savedEnv;
  });

  /** Run the command, advancing fake time by `advanceMs` while it waits. */
  async function run(args: string[], advanceMs = 0): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerSmellsCommand(program);
    const done = program.parseAsync(["smells", ...args], { from: "user" });
    if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
    await done;
    return logs.join("\n");
  }

  function waitPassed(): number | undefined {
    return fakeClient.runSmells.mock.calls[0]?.[0]?.timeoutMs;
  }

  describe("json", () => {
    it("prints stored smells marked stale when the run does not finish within 20 s", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      const out = JSON.parse(await run(["--format", "json"], 20_000));

      expect(waitPassed()).toBe(20_000);
      expect(fakeClient.listSmells).toHaveBeenCalledWith({ workspaceId: "ws-test", systemId: undefined });
      expect(out.stale).toBe(true);
      expect(out.computed_rev).toBe(12);
      expect(out.computed_at).toBe("2026-10-21T09:30:00Z");
      expect(out.diagnostics).toEqual([{
        code: "smells_stale",
        reason: "timeout",
        message: "fresh analysis did not finish within 20 s; showing stored results from rev 12 (2026-10-21T09:30:00Z)",
      }]);
      expect(out.count).toBe(2);
      expect(out.shown).toBe(2);
      expect(out.truncated).toBe(false);
      expect(out.inference_version).toBe("smell_v1");
      expect(out.rev).toBe(12);
      expect(out.run_at).toBe("2026-10-21T09:30:00Z");
      // A fresh run's `candidates`, highest confidence first, plus the
      // entity id cut to 12 as `--list` prints it.
      expect(out.candidates).toEqual([
        { file: "src/big.ts", smell: "has_smell.god_module", confidence: 0.9, signals: { chunks: 42, fan_in: 18, fan_out: 9 }, entity_id: "entity-b-012" },
        { file: "src/a.ts", smell: "has_smell.orphan_file", confidence: 0.4, signals: { connectivity: 0 }, entity_id: "entity-a-012" },
      ]);
      expect(out.smells).toBeUndefined();
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("does not give up before the budget", async () => {
      fakeClient.runSmells.mockImplementation(answersAfter(19_000, REPORT));
      const out = JSON.parse(await run(["--format", "json"], 19_000));
      expect(out.stale).toBeUndefined();
      expect(out.rev).toBe(7);
      expect(fakeClient.listSmells).not.toHaveBeenCalled();
    });

    it("falls back on a 403 with the not-permitted message", async () => {
      fakeClient.runSmells.mockRejectedValue(new Error('403: {"error":"forbidden"}'));
      const out = JSON.parse(await run(["--format", "json"]));

      expect(out.stale).toBe(true);
      expect(out.diagnostics).toEqual([{
        code: "smells_stale",
        reason: "not_permitted",
        message: "not permitted to run a fresh analysis; showing stored results from rev 12 (2026-10-21T09:30:00Z)",
      }]);
      expect(out.candidates).toHaveLength(2);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("says so when the stored rows carry no revision or time, as today's backend's do", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({
        smells: [{ smell: "has_smell.orphan_file", entity_id: "e1", value: { confidence: 0.5, file: "src/x.ts", signals: {} }, inference_version: "smell_v1" }],
        total: 1,
        truncated: false,
      });
      const out = JSON.parse(await run(["--format", "json"], 20_000));
      expect(out.computed_rev).toBeNull();
      expect(out.computed_at).toBeNull();
      expect("rev" in out).toBe(false);
      expect(out.diagnostics[0].message).toBe("fresh analysis did not finish within 20 s; showing stored results from an earlier run");
    });

    it("the backend's truncated stored list makes the answer truncated, and says how much came back", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({ ...STORED, total: 900, truncated: true });
      const out = JSON.parse(await run(["--format", "json"], 20_000));
      expect(out.truncated).toBe(true);
      expect(out.candidates).toHaveLength(2);
      expect(out.diagnostics[0].message).toBe(
        "fresh analysis did not finish within 20 s; showing stored results from rev 12 (2026-10-21T09:30:00Z); the backend returned 2 of 900 stored claims",
      );
    });

    it("drops non-source orphans and caps by --limit the way a fresh run does", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({
        smells: [
          ...STORED.smells,
          { smell: "has_smell.orphan_file", entity_id: "entity-c-0123456789", value: { confidence: 0.8, file: "README.md", signals: { connectivity: 0 } }, inference_version: "smell_v1" },
        ],
      });
      const out = JSON.parse(await run(["--format", "json", "--limit", "1"], 20_000));
      expect(out).toMatchObject({ count: 2, shown: 1, truncated: true, filtered_non_source: 1, stale: true });
      expect(out.candidates.map((c: { file: string }) => c.file)).toEqual(["src/big.ts"]);
    });

    it("reads a row that carries its fields at the top level too", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({ smells: [{ smell: "has_smell.orphan_file", entity_id: "e1", confidence: 0.5, file: "src/x.ts" }] });
      const out = JSON.parse(await run(["--format", "json"], 20_000));
      expect(out.candidates).toEqual([{ file: "src/x.ts", smell: "has_smell.orphan_file", confidence: 0.5, signals: {}, entity_id: "e1" }]);
    });

    it("keeps today's error, with a hint, when nothing is stored either", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({ smells: [] });
      const out = await run(["--format", "json"], 20_000);

      expect(out).toBe("");
      expect(process.exitCode).toBe(1);
      expect(errs.join("\n")).toContain("fresh analysis did not finish within 20 s and no stored results exist");
      expect(errs.join("\n")).toContain("Run ix smells interactively, or with a longer --wait");
    });

    it("keeps today's error for any other failure, without reading stored results", async () => {
      fakeClient.runSmells.mockRejectedValue(new Error("500: boom"));
      await run(["--format", "json"]);
      expect(process.exitCode).toBe(1);
      expect(errs.join("\n")).toContain("500: boom");
      expect(fakeClient.listSmells).not.toHaveBeenCalled();
    });
  });

  describe("llm", () => {
    it("prints one smells_stale diagnostic, then the stored smells", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      const lines = (await run(["--format", "llm"], 20_000)).split("\n");

      expect(waitPassed()).toBe(20_000);
      expect(lines).toEqual([
        "smells rev=12 count=2 shown=2 version=smell_v1",
        'diagnostic code=smells_stale reason=timeout computed_rev=12 computed_at=2026-10-21T09:30:00Z message="fresh analysis did not finish within 20 s; showing stored results from rev 12 (2026-10-21T09:30:00Z)"',
        "smell kind=has_smell.god_module file=src/big.ts confidence=0.9 chunks=42 fan_in=18 fan_out=9",
        "smell kind=has_smell.orphan_file file=src/a.ts confidence=0.4 connections=0",
      ]);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("on a 403", async () => {
      fakeClient.runSmells.mockRejectedValue(new Error("403: forbidden"));
      const lines = (await run(["--format", "llm"])).split("\n");
      expect(lines[1]).toContain("code=smells_stale reason=not_permitted");
      expect(lines[1]).toContain('message="not permitted to run a fresh analysis; showing stored results from rev 12');
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("caps stored smells at 50 by default, like a fresh run", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({
        smells: Array.from({ length: 60 }, (_, i) => ({ smell: "has_smell.orphan_file", entity_id: `e${i}`, value: { confidence: i / 100, file: `src/f${i}.ts` }, rev: 3 })),
      });
      const lines = (await run(["--format", "llm"], 20_000)).split("\n");
      expect(lines[0]).toBe("smells rev=3 count=60 shown=50 version=smell_v1");
      expect(lines[1]).toContain("code=smells_stale");
      expect(lines[2]).toContain("code=results_truncated");
      expect(lines.filter(l => l.startsWith("smell ")).length).toBe(50);
    });

    it("no stored results: today's error record with the hint, exit 1", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockResolvedValue({ smells: [] });
      const lines = (await run(["--format", "llm"], 20_000)).split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error code=backend_error message="fresh analysis did not finish within 20 s and no stored results exist\. Run ix smells interactively, or with a longer --wait\."$/);
      expect(process.exitCode).toBe(1);
    });

    it("stored results that cannot be read: the error path, exit 1", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      fakeClient.listSmells.mockRejectedValue(new Error("503: unavailable"));
      const lines = (await run(["--format", "llm"], 20_000)).split("\n");
      expect(lines[0]).toMatch(/^error code=backend_error /);
      expect(lines[0]).toContain("503: unavailable");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("text", () => {
    it("waits up to 10 minutes by default", async () => {
      fakeClient.runSmells.mockImplementation(answersAfter(5 * 60_000, REPORT));
      const out = await run([], 5 * 60_000);
      expect(waitPassed()).toBe(600_000);
      expect(out).toContain("Architecture Smells");
      expect(fakeClient.listSmells).not.toHaveBeenCalled();
    });

    it("prints a progress line about every 10 s when stderr is a terminal", async () => {
      process.stderr.isTTY = true;
      fakeClient.runSmells.mockImplementation(answersAfter(45_000, REPORT));
      await run([], 45_000);
      const progress = stderr.filter(s => s.includes("analysing smells"));
      expect(progress.map(s => s.match(/analysing smells… (\d+ s)/)?.[1])).toEqual(["10 s", "20 s", "30 s", "40 s"]);
    });

    it("prints no progress line when stderr is not a terminal", async () => {
      process.stderr.isTTY = false;
      fakeClient.runSmells.mockImplementation(answersAfter(45_000, REPORT));
      await run([], 45_000);
      expect(stderr.some(s => s.includes("analysing smells"))).toBe(false);
    });

    it("on expiry shows stored results under a visible stale header", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      const out = await run([], 600_000);
      expect(out).toContain("Stale: fresh analysis did not finish within 10 min; showing stored results from rev 12 (2026-10-21T09:30:00Z)");
      expect(out).toContain("Architecture Smells");
      expect(out).toContain("God Module");
      expect(out).toContain("src/big.ts");
      // Nothing was stored by this run, so no "claims stored" footer.
      expect(out).not.toContain("Smell claims stored");
      expect(process.exitCode ?? 0).toBe(0);
    });
  });

  describe("a wait longer than the HTTP client's 5 minute limit", () => {
    it("text: the 300 s headers timeout falls back to stored results, naming the time actually waited", async () => {
      fakeClient.runSmells.mockImplementation(headersTimeoutAt300s());
      const out = await run([], 300_000);
      expect(waitPassed()).toBe(600_000);
      expect(out).toContain("Stale: fresh analysis did not finish within 5 min, the longest the HTTP client waits for an answer; showing stored results from rev 12 (2026-10-21T09:30:00Z)");
      expect(out).toContain("God Module");
      expect(errs).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("json with a long --wait: stale answer, exit 0", async () => {
      fakeClient.runSmells.mockImplementation(headersTimeoutAt300s());
      const out = JSON.parse(await run(["--format", "json", "--wait", "900"], 300_000));
      expect(out.stale).toBe(true);
      expect(out.diagnostics).toEqual([{
        code: "smells_stale",
        reason: "timeout",
        message: "fresh analysis did not finish within 5 min, the longest the HTTP client waits for an answer; showing stored results from rev 12 (2026-10-21T09:30:00Z)",
      }]);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("a fetch failure without that code is still today's error", async () => {
      fakeClient.runSmells.mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
      await run(["--format", "json"]);
      expect(fakeClient.listSmells).not.toHaveBeenCalled();
      expect(errs.join("\n")).toContain("fetch failed");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("--wait and IX_SMELLS_WAIT", () => {
    it.each([
      [["--format", "json", "--wait", "5"], 5_000],
      [["--format", "llm", "--wait", "120"], 120_000],
      [["--wait", "30"], 30_000],
    ])("%j sets the budget", async (args, ms) => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      await run(args as string[]);
      expect(waitPassed()).toBe(ms);
    });

    it("a timed-out --wait names its own budget", async () => {
      fakeClient.runSmells.mockImplementation(neverAnswers());
      const out = JSON.parse(await run(["--format", "json", "--wait", "5"], 5_000));
      expect(out.diagnostics[0].message).toContain("did not finish within 5 s");
    });

    it("IX_SMELLS_WAIT sets it too, and --wait wins", async () => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      process.env.IX_SMELLS_WAIT = "45";
      await run(["--format", "json"]);
      expect(waitPassed()).toBe(45_000);

      fakeClient.runSmells.mockClear();
      logs.length = 0;
      await run(["--format", "json", "--wait", "7"]);
      expect(waitPassed()).toBe(7_000);
    });

    it("ignores a malformed IX_SMELLS_WAIT", async () => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      process.env.IX_SMELLS_WAIT = "15m";
      await run(["--format", "json"]);
      expect(waitPassed()).toBe(20_000);
    });

    it("caps IX_SMELLS_WAIT at an hour", async () => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      process.env.IX_SMELLS_WAIT = "99999999";
      await run(["--format", "json"]);
      expect(waitPassed()).toBe(3_600_000);
    });

    it("ignores IX_SMELLS_WAIT under MCP, whose runner gives ix_smells 30 s", async () => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      process.env.IX_SMELLS_WAIT = "45";
      const savedCaller = process.env.IX_CALLER;
      process.env.IX_CALLER = "mcp";
      try {
        await run(["--format", "json"]);
      } finally {
        if (savedCaller === undefined) delete process.env.IX_CALLER;
        else process.env.IX_CALLER = savedCaller;
      }
      expect(waitPassed()).toBe(20_000);
    });

    it("accepts a --wait of an hour, and refuses more", async () => {
      fakeClient.runSmells.mockResolvedValue(REPORT);
      await run(["--format", "json", "--wait", "3600"]);
      expect(waitPassed()).toBe(3_600_000);
      fakeClient.runSmells.mockClear();
      await expect(run(["--format", "json", "--wait", "3601"])).rejects.toMatchObject({
        code: "commander.invalidArgument",
        message: expect.stringContaining("at most 3600 seconds"),
      });
      expect(fakeClient.runSmells).not.toHaveBeenCalled();
    });

    it("rejects a --wait that is not a positive number of seconds", async () => {
      for (const bad of ["0", "-5", "abc", "1e3"]) {
        await expect(run(["--format", "json", "--wait", bad])).rejects.toMatchObject({ code: "commander.invalidArgument" });
      }
      expect(fakeClient.runSmells).not.toHaveBeenCalled();
    });
  });

  // Byte-identical to the output before the wait budget existed.
  describe("a backend that answers within the budget", () => {
    beforeEach(() => fakeClient.runSmells.mockResolvedValue(REPORT));

    it("json", async () => {
      expect(await run(["--format", "json"])).toBe(
        '{"rev":7,"run_at":"2026-10-11T00:00:00Z","count":3,"shown":3,"truncated":false,"inference_version":"smell_v1","candidates":[' +
        '{"file":"src/big.ts","smell":"has_smell.god_module","confidence":0.9,"signals":{"chunks":42,"fan_in":18,"fan_out":9}},' +
        '{"file":"README.md","smell":"has_smell.orphan_file","confidence":0.8,"signals":{"connectivity":0}},' +
        '{"file":"src/a.ts","smell":"has_smell.orphan_file","confidence":0.5,"signals":{"connectivity":0}}]}',
      );
    });

    it("llm", async () => {
      expect(await run(["--format", "llm"])).toBe([
        "smells rev=7 count=2 shown=2 filtered_non_source=1 version=smell_v1",
        "smell kind=has_smell.god_module file=src/big.ts confidence=0.9 chunks=42 fan_in=18 fan_out=9",
        "smell kind=has_smell.orphan_file file=src/a.ts confidence=0.5 connections=0",
      ].join("\n"));
      expect(stderr).toEqual(["Running smell detection...\n"]);
    });

    it("text", async () => {
      process.stderr.isTTY = true;
      expect(await run([])).toBe([
        "\nArchitecture Smells  rev 7 · 2 candidates (1 non-source orphan files hidden)",
        "\nGod Module  (1)",
        `  █████ ${"src/big.ts".padEnd(45)}  chunks=42 fan_in=18 fan_out=9`,
        "\nOrphan File  (1)",
        `  ███░░ ${"src/a.ts".padEnd(45)}  connections=0`,
        "\nSmell claims stored with inference_version=smell_v1. Use 'ix smells --list' to retrieve.",
      ].join("\n"));
      expect(stderr).toEqual(["Running smell detection...\n"]);
    });
  });
});
