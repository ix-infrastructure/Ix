// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { ALL_CONCURRENCY, registerCallersCommand } from "../commands/callers.js";
import { registerExplainCommand } from "../commands/explain.js";
import { registerImpactCommand } from "../commands/impact.js";
import { registerLocateCommand } from "../commands/locate.js";
import { WorkspaceNotMappedError, renderCliError, setErrorFormat } from "../errors.js";
import { LEGACY_EXIT_CODES_ENV, exitCodeFor, worseExitCode } from "../outcome.js";
import { ALL_CANDIDATE_CAP } from "../resolve.js";

// The outcome contract an agent routes on (outcome.ts): 0 results, 2 ambiguous
// (candidates returned), 3 not found (suggestions), 4 workspace not mapped,
// 1 a real error -- the same in every graph command, and the same slug in
// json `error` and llm `error code=`.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand, resolvePrefix } = vi.hoisted(() => ({ search: vi.fn(), expand: vi.fn(), resolvePrefix: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async resolvePrefix(...args: unknown[]) { return resolvePrefix(...args); }
    async entity(id: string) {
      return { node: { id, kind: "function", name: id, attrs: { line_start: 1, line_end: 2 }, provenance: { sourceUri: `src/${id}.ts` } } };
    }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

// The probe itself is covered by miss-reason.test.ts; here, only that its
// answer reaches every command's miss.
vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => true,
  explainSymbolMiss: async (_client: unknown, symbol: string) => symbol === "NotIndexed"
    ? {
        reason: "symbol_file_not_indexed",
        message: '"NotIndexed" is not in the graph, but it appears in src/gen.go, which has not been indexed.',
        files: ["src/gen.go"],
      }
    : null,
}));

const DUPLICATES = [
  { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
  { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
];
const UNIQUE = [{ id: "only-id", kind: "function", name: "Unique", provenance: { sourceUri: "src/only.ts" } }];

/** search() answers by term, so one run can mix hits, misses and ties. */
function graph(byName: Record<string, unknown[]>): void {
  search.mockImplementation(async (term: string) => byName[term] ?? []);
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  registerImpactCommand(program);
  registerLocateCommand(program);
  registerExplainCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => { stderr.push(parts.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => {
    stderr.push(String(part).replace(/\n$/, ""));
    return true;
  }) as never);
  process.exitCode = undefined;
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  delete process.env[LEGACY_EXIT_CODES_ENV];
  graph({ Duplicate: DUPLICATES, Unique: UNIQUE });
  expand.mockReset().mockImplementation(async (id: string, opts: { direction: string }) => ({
    nodes: [
      { id: `${opts.direction}-of-${id}`, kind: "function", name: `${opts.direction === "in" ? "callerOf" : "calleeOf"}_${id}`, provenance: { sourceUri: `src/${id}-user.ts` } },
      // Reached from every candidate: one row per candidate, each tagged.
      { id: "shared-id", kind: "function", name: "shared", provenance: { sourceUri: "src/shared.ts" } },
    ],
    edges: [],
  }));
});
afterEach(() => {
  vi.useRealTimers();
  process.exitCode = savedExitCode;
  delete process.env[LEGACY_EXIT_CODES_ENV];
});

const COMMANDS = ["locate", "callers", "callees", "impact", "explain"] as const;

describe.each(["locate", "callers", "impact", "explain"])("%s miss candidates", (command) => {
  function nearGraph(): void {
    // Model a 20ms base miss without depending on the test runner's CPU load.
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    search.mockImplementation(async (term: string, options?: { signal?: AbortSignal }) => {
      if (term === "parse_config" && !options?.signal) vi.advanceTimersByTime(20);
      return term === "parse" ? [{ id: "parser-id", name: "parseConfig", kind: "function", attrs: { line_start: 12 }, provenance: { sourceUri: "src/config.ts" } }] : [];
    });
  }

  it("adds bounded candidates without selecting a near match", async () => {
    nearGraph();
    const result = await run([command, "parse_config", "--format", "json"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: "unresolved_target",
      didYouMean: [{ name: "parseConfig", kind: "function", path: "src/config.ts", line: 12 }],
    });
    // The ambiguity field keeps its one meaning.
    expect(JSON.parse(result.stdout).candidates).toBeUndefined();
  });

  it("keeps llm suggestion ids when the probe supplies the names", async () => {
    nearGraph();
    const llm = (await run([command, "parse_config", "--format", "llm"])).stdout;
    expect(llm).toMatch(/suggestion n=1 name=parseConfig .*id=/);
  });

  it("keeps did-you-mean when every probe outlives its budget", async () => {
    // A slow backend: the bounded probes never answer in time, the resolver's
    // own near-name lookup (no budget) still does.
    search.mockImplementation((term: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      }
      return Promise.resolve(term === "parseConifg" ? [] : [{ id: "parser-id", name: "parseConfig", kind: "function", provenance: { sourceUri: "src/config.ts" } }]);
    });
    const json = JSON.parse((await run([command, "parseConifg", "--format", "json"])).stdout);
    expect(json.didYouMean).toEqual([]);
    expect(json.suggestions?.map((s: { name: string }) => s.name)).toEqual(["parseConfig"]);
    expect((await run([command, "parseConifg", "--format", "llm"])).stdout).toMatch(/suggestion n=1 name=parseConfig .*id=/);
    const text = await run([command, "parseConifg"]);
    expect(text.exitCode).toBe(3);
    expect(text.stderr).toContain("Did you mean:");
    expect(text.stderr).toContain("parseConfig");
  });

  // The resolver's own lookup (no signal) finds parseConfig; the bounded probe
  // for the exact term finds a different near name, parseConfg.
  function probeFinds(otherProbes: "answer" | "hang"): void {
    const config = { id: "parser-id", name: "parseConfig", kind: "function", provenance: { sourceUri: "src/config.ts" } };
    const other = { id: "other-id", name: "parseConfg", kind: "function", provenance: { sourceUri: "src/other.ts" } };
    search.mockImplementation((term: string, options?: { signal?: AbortSignal }) => {
      if (!options?.signal) return Promise.resolve(term === "parseConifg" ? [] : [config]);
      if (term === "parseConifg") return Promise.resolve([other]);
      if (otherProbes === "answer") return Promise.resolve([]);
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    });
  }

  it("keeps the resolver's suggestions first when the probe only partly answers", async () => {
    probeFinds("hang");
    const text = await run([command, "parseConifg"]);
    expect(text.exitCode).toBe(3);
    const rows = text.stderr.slice(text.stderr.indexOf("Did you mean:"));
    expect(rows.indexOf("parseConfig ")).toBeGreaterThan(-1);
    expect(rows.indexOf("parseConfg ")).toBeGreaterThan(rows.indexOf("parseConfig "));
    // A deadline-cut probe never names a winner.
    expect(text.stderr).not.toContain("Try:");
    const json = JSON.parse((await run([command, "parseConifg", "--format", "json"])).stdout);
    expect(json.suggestions.map((s: { name: string }) => s.name)).toEqual(["parseConfig"]);
  });

  it("drops a retry for an entity the suggestion rows do not list", async () => {
    probeFinds("answer");
    const llm = (await run([command, "parseConifg", "--format", "llm"])).stdout;
    expect(llm).toMatch(/suggestion n=1 name=parseConfig .*id=/);
    expect(llm).not.toContain("--path 'src/other.ts'");
    expect(llm).toContain("Re-run with one of these names");
    expect((await run([command, "parseConifg"])).stderr).not.toContain("Try:");
  });

  it("still suggests a long name more than two edits away", async () => {
    const row = { id: "input-id", name: "validateUserInput", kind: "function", provenance: { sourceUri: "src/validate.ts" } };
    search.mockImplementation(async (term: string) => (term === "validateUserImptx" ? [] : [row]));
    const json = JSON.parse((await run([command, "validateUserImptx", "--format", "json"])).stdout);
    expect(json.suggestions?.map((s: { name: string }) => s.name)).toEqual(["validateUserInput"]);
  });

  it("can disable candidate queries", async () => {
    search.mockClear();
    graph({});
    const result = await run([command, "Missing", "--no-suggest", "--format", "json"]);
    expect(JSON.parse(result.stdout).didYouMean).toEqual([]);
    expect(search.mock.calls.every(([, options]) => !options?.signal)).toBe(true);
  });

  it("preserves the existing JSON record, adding only didYouMean", async () => {
    graph({});
    const payload = JSON.parse((await run([command, "Missing", "--format", "json"])).stdout);
    const { didYouMean, ...legacy } = payload;
    expect(didYouMean).toEqual([]);
    expect(legacy).toEqual(command === "locate" ? {
      resolvedTarget: null, resolutionMode: "none", systemPath: null,
      diagnostics: ["No graph entity found."], error: "unresolved_target",
      message: 'No graph entity found for "Missing".',
    } : { error: "unresolved_target", message: 'No entity found matching "Missing".' });
  });

  it("prints did-you-mean and a path retry, without turning the miss into success", async () => {
    nearGraph();
    const result = await run([command, "parse_config"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Did you mean:");
    expect(result.stderr).toContain(`ix ${command} 'parseConfig' --path 'src/config.ts'`);
  });
});

describe.each(COMMANDS)("ix %s outcome codes", (command) => {
  it("exits 3 with unresolved_target for a name that is not in the graph", async () => {
    const json = await run([command, "Missing", "--format", "json"]);
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout).error).toBe("unresolved_target");

    const llm = await run([command, "Missing", "--format", "llm"]);
    expect(llm.exitCode).toBe(3);
    expect(llm.stdout).toMatch(/^error code=unresolved_target /);

    const text = await run([command, "Missing"]);
    expect(text.exitCode).toBe(3);
  });

  it("exits 2 with ambiguous_target and the candidates for a shared name", async () => {
    const json = await run([command, "Duplicate", "--format", "json"]);
    expect(json.exitCode).toBe(2);
    const body = JSON.parse(json.stdout);
    // locate's record was never an `error` (string-`error` readers treat it as
    // a failure and drop the candidates): its slug rides in `code`.
    if (command === "locate") {
      expect(body.code).toBe("ambiguous_target");
      expect(body.error).toBeUndefined();
    } else {
      expect(body.error).toBe("ambiguous_target");
    }
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["first-id", "second-id"]);

    const llm = await run([command, "Duplicate", "--format", "llm"]);
    expect(llm.exitCode).toBe(2);
    expect(llm.stdout).toMatch(/^error code=ambiguous_target /);
    expect(llm.stdout).toContain("candidate n=2 name=Duplicate");
  });

  it("collapses every non-zero outcome to 1 under IX_LEGACY_EXIT_CODES=1", async () => {
    process.env[LEGACY_EXIT_CODES_ENV] = "1";
    expect((await run([command, "Missing", "--format", "json"])).exitCode).toBe(1);
    expect((await run([command, "Duplicate", "--format", "json"])).exitCode).toBe(1);
  });
});

describe.each(["locate", "callers", "callees", "impact"] as const)("ix %s on a target that resolves", (command) => {
  it("exits 0", async () => {
    const result = await run([command, "Unique", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).error).toBeUndefined();
  });
});

describe("ambiguity hints name --all where it applies", () => {
  it("callers offers --all; locate does not", async () => {
    expect((await run(["callers", "Duplicate", "--format", "llm"])).stdout).toMatch(/hint text=".*--all/);
    expect((await run(["locate", "Duplicate", "--format", "llm"])).stdout).not.toContain("--all");
  });
});

class ExitCalled extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

describe("workspace not mapped", () => {
  it("exits 4 with workspace_not_mapped in json and llm, and 1 under the legacy switch", () => {
    // process.exit ends the run; the mock throws so nothing after it runs.
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new ExitCalled(code); }) as never);
    const render = (err: unknown) => { try { renderCliError(err); } catch (e) { if (!(e instanceof ExitCalled)) throw e; } };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      for (const format of ["json", "llm"]) {
        setErrorFormat(format);
        render(new WorkspaceNotMappedError("/tmp/elsewhere", "Run `ix map`."));
        expect(exit).toHaveBeenLastCalledWith(4);
      }
      expect(JSON.parse(String(log.mock.calls[0][0])).error).toBe("workspace_not_mapped");
      expect(String(log.mock.calls[1][0])).toMatch(/^error code=workspace_not_mapped /);

      process.env[LEGACY_EXIT_CODES_ENV] = "1";
      render(new WorkspaceNotMappedError("/tmp/elsewhere", "Run `ix map`."));
      expect(exit).toHaveBeenLastCalledWith(1);
    } finally {
      setErrorFormat(undefined);
      exit.mockRestore();
      log.mockRestore();
      write.mockRestore();
    }
  });
});

describe("exit code precedence", () => {
  it("keeps the worst outcome: error > not mapped > not found > ambiguous > ok", () => {
    expect(worseExitCode(0, 2)).toBe(2);
    expect(worseExitCode(2, 3)).toBe(3);
    expect(worseExitCode(3, 2)).toBe(3);
    expect(worseExitCode(3, 4)).toBe(4);
    expect(worseExitCode(4, 1)).toBe(1);
    expect(worseExitCode(1, 3)).toBe(1);
  });

  it("maps outcomes to their codes", () => {
    expect([exitCodeFor("ambiguous"), exitCodeFor("not_found"), exitCodeFor("not_mapped")]).toEqual([2, 3, 4]);
    process.env[LEGACY_EXIT_CODES_ENV] = "true";
    expect([exitCodeFor("ambiguous"), exitCodeFor("not_found"), exitCodeFor("not_mapped")]).toEqual([1, 1, 1]);
    process.env[LEGACY_EXIT_CODES_ENV] = "0";
    expect(exitCodeFor("not_found")).toBe(3);
  });
});

describe("--all on an ambiguous target", () => {
  it.each(["callers", "callees"] as const)("%s: unions every candidate's rows, each tagged with its candidate (json)", async (command) => {
    const result = await run([command, "Duplicate", "--all", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.error).toBeUndefined();
    expect(body.resolutionMode).toBe("all");
    expect(body.candidates).toEqual([
      { n: 1, id: "first-id", name: "Duplicate", kind: "function", path: "src/first.ts" },
      { n: 2, id: "second-id", name: "Duplicate", kind: "function", path: "src/second.ts" },
    ]);
    const prefix = command === "callers" ? "callerOf" : "calleeOf";
    const rows = body.results.map((r: { name: string; candidate: number }) => `${r.candidate}:${r.name}`).sort();
    expect(rows).toEqual([`1:${prefix}_first-id`, "1:shared", `2:${prefix}_second-id`, "2:shared"]);
    expect(body.summary.total).toBe(4);
    // One query per candidate, never one by name.
    expect(expand.mock.calls.map(([id]) => id).sort()).toEqual(["first-id", "second-id"]);
  });

  it("callers: llm lists the candidates and tags every ref", async () => {
    const result = await run(["callers", "Duplicate", "--all", "--format", "llm"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^callers target=Duplicate .*total=4 .*candidates=2/);
    expect(lines.filter((l) => l.startsWith("candidate "))).toEqual([
      expect.stringMatching(/^candidate n=1 name=Duplicate kind=function path=src\/first.ts/),
      expect.stringMatching(/^candidate n=2 name=Duplicate kind=function path=src\/second.ts/),
    ]);
    const refs = lines.filter((l) => l.startsWith("ref "));
    expect(refs).toHaveLength(4);
    for (const ref of refs) expect(ref).toMatch(/ candidate=[12]$/);
  });

  it("callers: pages over the union with --limit/--offset", async () => {
    const first = JSON.parse((await run(["callers", "Duplicate", "--all", "--limit", "3", "--format", "json"])).stdout);
    const second = JSON.parse((await run(["callers", "Duplicate", "--all", "--limit", "3", "--offset", "3", "--format", "json"])).stdout);
    expect(first.results).toHaveLength(3);
    expect(first.summary.nextOffset).toBe(3);
    expect(second.results).toHaveLength(1);
    const all = [...first.results, ...second.results].map((r: { candidate: number; name: string }) => `${r.candidate}:${r.name}`);
    expect(new Set(all).size).toBe(4);
  });

  it("is plain resolution for a name that resolves, and still a miss for one that does not", async () => {
    const one = JSON.parse((await run(["callers", "Unique", "--all", "--format", "json"])).stdout);
    expect(one.resolvedTarget).toMatchObject({ id: "only-id" });
    expect(one.candidates).toBeUndefined();
    expect(one.results.every((r: { candidate?: number }) => r.candidate === undefined)).toBe(true);

    const miss = await run(["callers", "Missing", "--all", "--format", "json"]);
    expect(miss.exitCode).toBe(3);
  });

  it("--pick wins over --all", async () => {
    const body = JSON.parse((await run(["callers", "Duplicate", "--all", "--pick", "2", "--format", "json"])).stdout);
    expect(body.resolvedTarget).toMatchObject({ id: "second-id" });
    expect(body.candidates).toBeUndefined();
  });

  const manyNamed = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `dup-${String(i).padStart(2, "0")}`, kind: "function", name: "Many", provenance: { sourceUri: `src/m${String(i).padStart(2, "0")}.ts` },
  }));

  it("covers every tied candidate, not only the 8 an ambiguity lists", async () => {
    graph({ Many: manyNamed(12) });
    // Without --all the error still lists 8 of 12.
    const plain = JSON.parse((await run(["callers", "Many", "--format", "json"])).stdout);
    expect(plain.candidates).toHaveLength(8);
    expect(plain.total).toBe(12);
    expect(Object.keys(plain)).not.toContain("allCandidates");

    expand.mockClear();
    const body = JSON.parse((await run(["callers", "Many", "--all", "--limit", "100", "--format", "json"])).stdout);
    expect(body.candidates).toHaveLength(12);
    // The 8 listed keep the numbers --pick gives them; the rest follow.
    expect(body.candidates.slice(0, 8).map((c: { id: string }) => c.id))
      .toEqual(plain.candidates.map((c: { id: string }) => c.id));
    expect(new Set(expand.mock.calls.map(([id]) => id)).size).toBe(12);
    expect(body.summary.total).toBe(24);
    expect((body.diagnostics ?? []).map((d: { code: string }) => d.code)).not.toContain("candidates_truncated");
  });

  it("lets --pick reach a candidate past the 8 listed by the number --all gave it", async () => {
    graph({ Many: manyNamed(12) });
    const all = JSON.parse((await run(["callers", "Many", "--all", "--format", "json"])).stdout);
    const eleventh = all.candidates.find((c: { n: number }) => c.n === 11);
    expect(eleventh).toBeDefined();

    const picked = JSON.parse((await run(["callers", "Many", "--pick", "11", "--format", "json"])).stdout);
    expect(picked.resolvedTarget).toMatchObject({ id: eleventh.id });

    const out = await run(["callers", "Many", "--pick", "13", "--format", "json"]);
    expect(out.stdout).toContain("--pick 13 is out of range (1-12).");
  });

  it("keeps at most ALL_CONCURRENCY edge queries in flight", async () => {
    graph({ Many: manyNamed(12) });
    const base = expand.getMockImplementation()!;
    let inFlight = 0;
    let peak = 0;
    expand.mockImplementation(async (...args: unknown[]) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return base(...(args as [string, { direction: string }]));
    });
    const result = await run(["callers", "Many", "--all", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(expand).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(ALL_CONCURRENCY);
  });

  it("says when the name search itself was cut off", async () => {
    graph({ Many: manyNamed(60) });
    const body = JSON.parse((await run(["callers", "Many", "--all", "--limit", "500", "--format", "json"])).stdout);
    expect(body.candidates.length).toBeGreaterThan(8);
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toContain("candidates_truncated");
  });

  it("answers at most ALL_CANDIDATE_CAP candidates and says so", async () => {
    graph({ Many: manyNamed(ALL_CANDIDATE_CAP + 5) });
    expand.mockClear();
    const body = JSON.parse((await run(["callers", "Many", "--all", "--limit", "500", "--format", "json"])).stdout);
    expect(body.candidates).toHaveLength(ALL_CANDIDATE_CAP);
    expect(body.candidates.map((c: { n: number }) => c.n)).toEqual(Array.from({ length: ALL_CANDIDATE_CAP }, (_, i) => i + 1));
    expect(new Set(expand.mock.calls.map(([id]) => id)).size).toBe(ALL_CANDIDATE_CAP);
    const cut = body.diagnostics.find((d: { code: string }) => d.code === "candidates_truncated");
    expect(cut.message).toContain(`first ${ALL_CANDIDATE_CAP} of ${ALL_CANDIDATE_CAP + 5}`);

    const impact = JSON.parse((await run(["impact", "Many", "--all", "--format", "json"])).stdout);
    expect(impact.results).toHaveLength(ALL_CANDIDATE_CAP);
    expect(impact.diagnostics.map((d: { code: string }) => d.code)).toContain("candidates_truncated");

    // A candidate past the cap is still reachable by its number.
    const picked = JSON.parse((await run(["callers", "Many", "--pick", String(ALL_CANDIDATE_CAP + 3), "--format", "json"])).stdout);
    expect(picked.resolvedTarget).toMatchObject({ id: `dup-${ALL_CANDIDATE_CAP + 2}` });
  });

  // `from app.utils import clamp` is a one-line `module` named clamp: an
  // ambiguity lists it, but it is not a definition (candidate-origin.ts).
  const CLAMP_IMPORT = { id: "import-id", kind: "module", name: "clamp", attrs: { line_start: 3, line_end: 3 }, provenance: { sourceUri: "app/pricing.py" } };
  const CLAMP_DEFS = [
    { id: "py-id", kind: "function", name: "clamp", attrs: { line_start: 22, line_end: 23 }, provenance: { sourceUri: "app/utils.py" } },
    { id: "ts-id", kind: "function", name: "clamp", attrs: { line_start: 9, line_end: 11 }, provenance: { sourceUri: "web/src/math.ts" } },
  ];

  it("skips an import of the name when definitions are listed, keeping --pick numbers", async () => {
    // A second definition in app/utils.py. The import scores worse than every
    // definition, so it ranks last (the file round-robin deals only among
    // equal scores) and the definitions keep their shown numbers under --all.
    const pyAgain = { ...CLAMP_DEFS[0], id: "py2-id", attrs: { line_start: 40, line_end: 41 } };
    graph({ clamp: [CLAMP_IMPORT, ...CLAMP_DEFS, pyAgain] });
    const plain = JSON.parse((await run(["callers", "clamp", "--format", "json"])).stdout);
    expect(plain.candidates.map((c: { id: string; rank: number }) => [c.rank, c.id]))
      .toEqual([[1, "py-id"], [2, "ts-id"], [3, "py2-id"], [4, "import-id"]]);

    expand.mockClear();
    const body = JSON.parse((await run(["callers", "clamp", "--all", "--format", "json"])).stdout);
    expect(body.candidates.map((c: { n: number; id: string }) => [c.n, c.id]))
      .toEqual([[1, "py-id"], [2, "ts-id"], [3, "py2-id"]]);
    expect(new Set(body.results.map((r: { candidate: number }) => r.candidate))).toEqual(new Set([1, 2, 3]));
    expect(expand.mock.calls.map(([id]) => id).sort()).toEqual(["py-id", "py2-id", "ts-id"]);
    // The skipped import is not a candidate the search cut off.
    expect((body.diagnostics ?? []).map((d: { code: string }) => d.code)).not.toContain("candidates_truncated");

    const impact = JSON.parse((await run(["impact", "clamp", "--all", "--format", "json"])).stdout);
    expect(impact.results.map((r: { candidate: number }) => r.candidate)).toEqual([1, 2, 3]);
  });

  it("still answers for imports when no definition is listed", async () => {
    const other = { ...CLAMP_IMPORT, id: "import-2", provenance: { sourceUri: "web/src/format.ts" } };
    graph({ clamp: [CLAMP_IMPORT, other] });
    const body = JSON.parse((await run(["callers", "clamp", "--all", "--format", "json"])).stdout);
    expect(body.candidates.map((c: { n: number; id: string }) => [c.n, c.id])).toEqual([[1, "import-id"], [2, "import-2"]]);
  });

  it("impact: one analysis per candidate, tagged (json and llm)", async () => {
    const json = await run(["impact", "Duplicate", "--all", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body).toMatchObject({ target: "Duplicate", resolutionMode: "all" });
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["first-id", "second-id"]);
    expect(body.results.map((r: { candidate: number; resolvedTarget: { name: string } }) => [r.candidate, r.resolvedTarget.name]))
      .toEqual([[1, "Duplicate"], [2, "Duplicate"]]);
    // Each analysis read its own candidate's edges.
    const ids = new Set(expand.mock.calls.map(([id]) => id));
    expect(ids.has("first-id") && ids.has("second-id")).toBe(true);

    const llm = await run(["impact", "Duplicate", "--all", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    const lines = llm.stdout.split("\n");
    expect(lines[0]).toBe("impact_all target=Duplicate candidates=2 total=2");
    const firstCandidate = lines.findIndex((l) => l.startsWith("candidate n=1"));
    const secondCandidate = lines.findIndex((l) => l.startsWith("candidate n=2"));
    expect(firstCandidate).toBeGreaterThan(0);
    expect(secondCandidate).toBeGreaterThan(firstCandidate + 1);
  });
});

describe("several targets in one call", () => {
  it("locate: json groups per target, with each target's own exit code; the run exits with the worst", async () => {
    const result = await run(["locate", "Unique", "Duplicate", "Missing", "--format", "json"]);
    expect(result.exitCode).toBe(3);
    const body = JSON.parse(result.stdout);
    expect(body.targets.map((t: { target: string; exitCode: number }) => [t.target, t.exitCode]))
      .toEqual([["Unique", 0], ["Duplicate", 2], ["Missing", 3]]);
    expect(body.targets[0].resolvedTarget).toMatchObject({ id: "only-id" });
    expect(body.targets[1].code).toBe("ambiguous_target");
    expect(body.targets[1].error).toBeUndefined();
    expect(body.targets[2].error).toBe("unresolved_target");
    expect(body.summary).toEqual({ total: 3, ok: 1, ambiguous: 1, notFound: 1, notMapped: 0, failed: 0 });
  });

  it("the summary counts an unmapped target as not mapped, and a miss the same under the legacy switch", async () => {
    const base = search.getMockImplementation()!;
    search.mockImplementation(async (term: string, ...rest: unknown[]) => {
      if (term === "Elsewhere") throw new WorkspaceNotMappedError("/tmp/elsewhere", "Run `ix map`.");
      return base(term, ...rest);
    });
    const json = await run(["locate", "Unique", "Elsewhere", "Missing", "--format", "json"]);
    expect(json.exitCode).toBe(4);
    const body = JSON.parse(json.stdout);
    // The same fields as the one-target record (errors.ts renderCliError), `dir` included.
    expect(body.targets[1]).toMatchObject({ target: "Elsewhere", exitCode: 4, error: "workspace_not_mapped", dir: "/tmp/elsewhere", next: "Run `ix map`." });
    expect(body.summary).toEqual({ total: 3, ok: 1, ambiguous: 0, notFound: 1, notMapped: 1, failed: 0 });
    const llm = await run(["locate", "Unique", "Elsewhere", "--format", "llm"]);
    expect(llm.stdout).toMatch(/^error code=workspace_not_mapped .* dir=\/tmp\/elsewhere hint=/m);
    expect(llm.stdout.split("\n").pop()).toBe("targets total=2 ok=1 not_mapped=1");

    // Every miss exits 1 under the switch; the summary still tells them apart.
    process.env[LEGACY_EXIT_CODES_ENV] = "1";
    const legacy = await run(["locate", "Unique", "Duplicate", "Missing", "Elsewhere", "--format", "json"]);
    expect(legacy.exitCode).toBe(1);
    const legacyBody = JSON.parse(legacy.stdout);
    expect(legacyBody.targets.map((t: { exitCode: number }) => t.exitCode)).toEqual([0, 1, 1, 1]);
    expect(legacyBody.summary).toEqual({ total: 4, ok: 1, ambiguous: 1, notFound: 1, notMapped: 1, failed: 0 });
  });

  it("callers: llm opens each group with a target record and ends with a summary", async () => {
    const result = await run(["callers", "Unique", "Duplicate", "--format", "llm"]);
    expect(result.exitCode).toBe(2);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("target n=1 name=Unique");
    expect(lines[1]).toMatch(/^callers target=Unique /);
    const second = lines.indexOf("target n=2 name=Duplicate");
    expect(second).toBeGreaterThan(1);
    expect(lines[second + 1]).toMatch(/^error code=ambiguous_target /);
    expect(lines[lines.length - 1]).toBe("targets total=2 ok=1 ambiguous=1");
  });

  it("callers: every target answered exits 0, with one group each", async () => {
    graph({ Unique: UNIQUE, Other: [{ id: "other-id", kind: "function", name: "Other", provenance: { sourceUri: "src/other.ts" } }] });
    const result = await run(["callers", "Unique", "Other", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.targets.map((t: { resolvedTarget: { id: string } }) => t.resolvedTarget.id)).toEqual(["only-id", "other-id"]);
    expect(body.targets[1].results.map((r: { name: string }) => r.name)).toContain("callerOf_other-id");
  });

  it("a target whose query throws gets its own error group; the others still answer", async () => {
    graph({ Unique: UNIQUE, Other: [{ id: "other-id", kind: "function", name: "Other", provenance: { sourceUri: "src/other.ts" } }] });
    const base = expand.getMockImplementation()!;
    expand.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "only-id") throw new Error('500: {"error":"query_failed","message":"backend broke"}');
      return base(...(args as [string, { direction: string }]));
    });
    const json = await run(["callers", "Unique", "Other", "--format", "json"]);
    expect(json.exitCode).toBe(1);
    const body = JSON.parse(json.stdout);
    expect(body.targets[0]).toMatchObject({ target: "Unique", exitCode: 1, error: "query_failed", message: "backend broke" });
    expect(body.targets[1]).toMatchObject({ target: "Other", exitCode: 0 });
    expect(body.targets[1].results.map((r: { name: string }) => r.name)).toContain("callerOf_other-id");
    expect(body.summary).toEqual({ total: 2, ok: 1, ambiguous: 0, notFound: 0, notMapped: 0, failed: 1 });

    const llm = await run(["callers", "Unique", "Other", "--format", "llm"]);
    expect(llm.exitCode).toBe(1);
    const lines = llm.stdout.split("\n");
    expect(lines[1]).toMatch(/^error code=query_failed /);
    expect(lines).toContain("target n=2 name=Other");
    expect(lines[lines.length - 1]).toBe("targets total=2 ok=1 failed=1");
  });

  it("text: a header per target", async () => {
    const result = await run(["locate", "Unique", "Missing"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("── Unique ──");
    expect(result.stdout).toContain("── Missing ──");
  });

  it("one target prints exactly what it always did", async () => {
    const result = await run(["locate", "Unique", "--format", "json"]);
    expect(JSON.parse(result.stdout).targets).toBeUndefined();
  });
});

describe("locate misses carry the fields every miss carries", () => {
  it("suggestions for a near name, in json and llm", async () => {
    search.mockImplementation(async (term: string) => (term === "Uniqu" ? [] : UNIQUE));
    const json = JSON.parse((await run(["locate", "Uniqu", "--format", "json"])).stdout);
    expect(json.error).toBe("unresolved_target");
    expect(json.suggestions?.map((s: { name: string }) => s.name)).toEqual(["Unique"]);
    const llm = (await run(["locate", "Uniqu", "--format", "llm"])).stdout;
    expect(llm).toContain("suggestion n=1 name=Unique");
  });
});

describe.each(COMMANDS)("ix %s says why a name is not in the graph", (command) => {
  it("json carries reason, files and the message; llm the reason; text the message", async () => {
    const json = await run([command, "NotIndexed", "--format", "json"]);
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: "unresolved_target",
      reason: "symbol_file_not_indexed",
      message: expect.stringContaining("src/gen.go, which has not been indexed"),
    });
    expect(JSON.parse(json.stdout).files).toEqual(["src/gen.go"]);

    const llm = await run([command, "NotIndexed", "--format", "llm"]);
    expect(llm.stdout).toMatch(/^error code=unresolved_target .*reason=symbol_file_not_indexed/);

    const text = await run([command, "NotIndexed"]);
    expect(text.stderr).toContain("src/gen.go, which has not been indexed");
  });
});

describe("an id lookup the backend could not answer", () => {
  const RAW_ID = "12345678-1234-1234-1234-123456789abc";

  it("is a real error, not a missing symbol", async () => {
    const { resolveFileOrEntityFull } = await import("../resolve.js");
    const down = { entity: async () => { throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:8090"); } };
    await expect(resolveFileOrEntityFull(down as never, RAW_ID, { format: "json" })).rejects.toThrow(/ECONNREFUSED/);
    const failing = { entity: async () => { throw new Error("500: internal error"); } };
    await expect(resolveFileOrEntityFull(failing as never, RAW_ID, { format: "json" })).rejects.toThrow(/^500:/);
  });

  it("is a miss only when the backend says the id does not exist", async () => {
    const { resolveFileOrEntityFull, isLookupMiss } = await import("../resolve.js");
    const absent = { entity: async () => { throw new Error("404: not found"); } };
    expect(await resolveFileOrEntityFull(absent as never, RAW_ID, { format: "json" })).toEqual({ resolved: false, ambiguous: false });
    expect(isLookupMiss(new Error("No entity found for prefix: abcd1234"))).toBe(true);
    expect(isLookupMiss(new Error("401: unauthorized"))).toBe(false);
  });

  it("is a miss when the backend answers 200 without a node", async () => {
    const { resolveFileOrEntityFull } = await import("../resolve.js");
    for (const body of [{ node: null }, {}, null]) {
      const empty = { entity: async () => body };
      expect(await resolveFileOrEntityFull(empty as never, RAW_ID, { format: "json" })).toEqual({ resolved: false, ambiguous: false });
    }
  });

  it("a hex-looking name falls through to the name search whatever the prefix lookup answers", async () => {
    graph({ deadbeef: [{ id: "beef-id", kind: "function", name: "deadbeef", provenance: { sourceUri: "src/beef.ts" } }] });
    const { resolveFileOrEntityFull } = await import("../resolve.js");
    for (const status of ["403: forbidden", "405: method not allowed", "502: <html>bad gateway</html>"]) {
      resolvePrefix.mockReset().mockRejectedValue(new Error(status));
      const { IxClient } = await import("../../client/api.js");
      const result = await resolveFileOrEntityFull(new (IxClient as any)(), "deadbeef", { format: "json" });
      expect(result).toMatchObject({ resolved: true, entity: { id: "beef-id" } });
    }
    const down = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    resolvePrefix.mockReset().mockRejectedValue(down);
    const { IxClient } = await import("../../client/api.js");
    await expect(resolveFileOrEntityFull(new (IxClient as any)(), "deadbeef", { format: "json" })).rejects.toThrow(/fetch failed/);
  });
});

describe("subsystems and around carry the same outcome codes as their slugs", () => {
  it("subsystems: an ambiguous region exits 2, an unknown one 3, any other error 1", async () => {
    const { setSubsystemErrorExit } = await import("../commands/subsystems.js");
    const exitFor = (body: unknown) => { process.exitCode = undefined; setSubsystemErrorExit(body); return Number(process.exitCode); };
    expect(exitFor({ error: "ambiguous_target", target_query: "api", candidates: [] })).toBe(2);
    expect(exitFor({ error: "unknown_target", message: "No region api", suggestions: [] })).toBe(3);
    expect(exitFor({ error: "query_failed" })).toBe(1);
    process.env[LEGACY_EXIT_CODES_ENV] = "1";
    expect(exitFor({ error: "ambiguous_target", target_query: "api", candidates: [] })).toBe(1);
  });

  it("around: a file not in the graph exits 3, a bad argument 1", async () => {
    const { reportError } = await import("../commands/around.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.exitCode = undefined;
      reportError("unresolved_target", "not in the graph", "llm", [["reason", "file_not_in_graph"]]);
      expect(process.exitCode).toBe(3);
      process.exitCode = undefined;
      reportError("invalid_line_range", "bad range", "llm");
      expect(process.exitCode).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
