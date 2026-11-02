// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerExplainCommand } from "../commands/explain.js";
import { registerImpactCommand } from "../commands/impact.js";
import { registerLocateCommand } from "../commands/locate.js";
import { resetResolutionNotices } from "../format.js";
import { LEGACY_EXIT_CODES_ENV, STRICT_TARGETS_ENV } from "../outcome.js";

// A graph command answers instead of erroring (outcome.ts): an ambiguous name
// is answered for its top candidate, with an `ambiguous_target` notice that
// lists the rest, and a name that is no code symbol but is in source files is
// answered with those files. `--strict` / IX_STRICT_TARGETS=1 keep the errors.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand, entity } = vi.hoisted(() => ({ search: vi.fn(), expand: vi.fn(), entity: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async entity(id: string) {
      entity(id);
      return { node: { id, kind: "function", name: id, attrs: { line_start: 1, line_end: 2 }, provenance: { sourceUri: `src/${id}.ts` } } };
    }
    async provenance(id: string) { return { entityId: id, chain: [] }; }
    async listByKind() { return []; }
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

// The probe's own rg is covered by miss-reason.test.ts (with a config-key
// fixture); here, what each command does with its answer.
vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => true,
  explainSymbolMiss: async (_client: unknown, symbol: string) => {
    if (symbol === "redrivePolicy") {
      return {
        reason: "symbol_not_extracted",
        message: '"redrivePolicy" is not in the graph.',
        files: ["lib/plugins/aws/events/sqs.js"],
        matches: [
          // rg order (sorted by path): docs and changelog ahead of source.
          { path: "CHANGELOG.md", line: 4, snippet: "- Support redrivePolicy" },
          { path: "docs/providers/aws/events/sqs.md", line: 30, snippet: "redrivePolicy: arn" },
          { path: "lib/plugins/aws/events/sqs.js", line: 88, snippet: "const redrivePolicy = event.redrivePolicy;" },
          { path: "lib/plugins/aws/package/compile.js", line: 12, snippet: "      redrivePolicy: {" },
          { path: "test/unit/sqs.test.js", line: 5, snippet: "redrivePolicy: 'x'" },
        ],
      };
    }
    if (symbol === "nearKey" || symbol === "Router.handle") {
      // The probe greps the last segment of a qualified name.
      const term = symbol === "nearKey" ? "nearKey" : "handle";
      return {
        reason: "symbol_not_extracted",
        message: `"${term}" is not in the graph.`,
        files: ["src/a.ts"],
        matches: [{ path: "src/a.ts", line: 3, snippet: `this.${term}(req)` }],
      };
    }
    if (symbol === "docsOnlyKey") {
      return {
        reason: "symbol_not_extracted",
        message: '"docsOnlyKey" is not in the graph.',
        files: ["docs/conf.py"],
        matches: [
          { path: "CHANGELOG.md", line: 1, snippet: "docsOnlyKey" },
          { path: "docs/conf.py", line: 2, snippet: "docsOnlyKey = 1" },
          { path: "test/test_conf.py", line: 3, snippet: "docsOnlyKey" },
        ],
      };
    }
    return null;
  },
}));

// The miss's did-you-mean probe (target-suggestions.ts) finds a real entity
// near a name that is also only text.
vi.mock("../target-suggestions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../target-suggestions.js")>();
  return {
    ...actual,
    findTargetCandidates: async (...args: Parameters<typeof actual.findTargetCandidates>) => args[1] === "nearKey"
      ? {
          didYouMean: [{ name: "loadKeys", kind: "function", path: "src/near.ts", line: 1 }],
          suggestions: [{ id: "near-id", name: "loadKeys", kind: "function", path: "src/near.ts" }],
        }
      : actual.findTargetCandidates(...args),
  };
});

const DUPLICATES = [
  { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
  { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
];
const UNIQUE = [{ id: "only-id", kind: "function", name: "Unique", provenance: { sourceUri: "src/only.ts" } }];
// The method a qualified miss's last segment names.
const HANDLE = [{ id: "handle-id", kind: "method", name: "handle", provenance: { sourceUri: "src/dispatcher.ts" } }];

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
  resetResolutionNotices();
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

/** Every entity id the command asked the graph about once it had resolved. */
function idsAsked(): string[] {
  return [...expand.mock.calls.map((c) => String(c[0])), ...entity.mock.calls.map((c) => String(c[0]))];
}

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  delete process.env[LEGACY_EXIT_CODES_ENV];
  delete process.env[STRICT_TARGETS_ENV];
  search.mockReset().mockImplementation(async (term: string) => ({ Duplicate: DUPLICATES, Unique: UNIQUE, handle: HANDLE } as Record<string, unknown[]>)[term] ?? []);
  expand.mockReset().mockResolvedValue({ nodes: [], edges: [] });
  entity.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
  delete process.env[LEGACY_EXIT_CODES_ENV];
  delete process.env[STRICT_TARGETS_ENV];
  resetResolutionNotices();
});

describe.each(["locate", "callers", "impact", "explain"])("ix %s on an ambiguous target", (command) => {
  it("answers for the top candidate in json, exit 0, with the ambiguous_target notice", async () => {
    const json = await run([command, "Duplicate", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.error).toBeUndefined();
    const notice = body.resolutionNotices?.find((n: { code: string }) => n.code === "ambiguous_target");
    expect(notice).toMatchObject({ code: "ambiguous_target", target: "Duplicate", total: 2, chosen: { id: "first-id" } });
    expect(notice.candidates.map((c: { id: string }) => c.id)).toEqual(["first-id", "second-id"]);
    expect(notice.message).toContain('"Duplicate" matches 2 candidates; using Duplicate (src/first.ts)');
    expect(idsAsked()).toContain("first-id");
    expect(idsAsked()).not.toContain("second-id");
  });

  it("answers in llm with a diagnostic, not an error record, and lists the others", async () => {
    const llm = await run([command, "Duplicate", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    expect(llm.stdout).not.toMatch(/^error code=/m);
    expect(llm.stdout).toMatch(/^diagnostic code=ambiguous_target target=Duplicate chosen=Duplicate shown=2 total=2 /m);
    expect(llm.stdout).toContain("candidate n=2 name=Duplicate kind=function path=src/second.ts");
    expect(llm.stdout).toMatch(/^hint text="Use --pick <n> or --path to choose another\."/m);
  });

  it("says what it chose in text, on stderr, and exits 0", async () => {
    const text = await run([command, "Duplicate"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toContain('"Duplicate" matches 2 candidates; using Duplicate (src/first.ts)');
    expect(text.stderr).toContain("Use --pick <n> or --path to choose another.");
  });

  it("--pick 2 selects the second candidate of the same list", async () => {
    const json = await run([command, "Duplicate", "--pick", "2", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.resolutionNotices).toBeUndefined();
    expect(idsAsked()).toContain("second-id");
    expect(idsAsked()).not.toContain("first-id");
  });

  it("an out-of-range --pick answers for the top candidate, exit 0, saying the pick was out of range", async () => {
    const json = await run([command, "Duplicate", "--pick", "3", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const notice = JSON.parse(json.stdout).resolutionNotices[0];
    expect(notice).toMatchObject({ code: "ambiguous_target", chosen: { id: "first-id" } });
    expect(notice.diagnostics).toEqual([{ code: "pick_out_of_range", message: "--pick 3 is out of range (1-2)." }]);
  });

  it("--strict keeps the ambiguous_target error and exit 2", async () => {
    const json = await run([command, "Duplicate", "--strict", "--format", "json"]);
    expect(json.exitCode).toBe(2);
    const body = JSON.parse(json.stdout);
    expect(command === "locate" ? body.code : body.error).toBe("ambiguous_target");
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["first-id", "second-id"]);

    const llm = await run([command, "Duplicate", "--strict", "--format", "llm"]);
    expect(llm.exitCode).toBe(2);
    expect(llm.stdout).toMatch(/^error code=ambiguous_target /);
  });

  it("IX_STRICT_TARGETS=1 keeps the error too, and IX_LEGACY_EXIT_CODES still makes it 1", async () => {
    process.env[STRICT_TARGETS_ENV] = "1";
    const llm = await run([command, "Duplicate", "--format", "llm"]);
    expect(llm.exitCode).toBe(2);
    expect(llm.stdout).toMatch(/^error code=ambiguous_target /);
    process.env[LEGACY_EXIT_CODES_ENV] = "1";
    expect((await run([command, "Duplicate", "--format", "json"])).exitCode).toBe(1);
    process.env[STRICT_TARGETS_ENV] = "0";
    expect((await run([command, "Duplicate", "--format", "json"])).exitCode).toBe(0);
  });
});

describe.each(["locate", "callers", "impact", "explain"])("ix %s on a name that is not a code symbol", (command) => {
  it("answers with the source files that mention it, source first, exit 0 (llm)", async () => {
    const llm = await run([command, "redrivePolicy", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    expect(llm.stdout).not.toMatch(/^error code=/m);
    const lines = llm.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("note code=text_matches"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at]).toContain('message="\\"redrivePolicy\\" is not a code symbol in the graph; source files that mention it:"');
    const rows = lines.slice(at + 1).filter((l) => l.startsWith("match "));
    // Source only: the changelog, the docs page and the test are not listed.
    expect(rows).toEqual([
      'match n=1 path=lib/plugins/aws/events/sqs.js line=88 text="const redrivePolicy = event.redrivePolicy;"',
      'match n=2 path=lib/plugins/aws/package/compile.js line=12 text="redrivePolicy: {"',
    ]);
  });

  it("json carries textMatches with a note, and no unresolved_target record", async () => {
    const json = await run([command, "redrivePolicy", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.error).toBeUndefined();
    expect(body.note).toBe("text_matches");
    expect(body.reason).toBe("symbol_not_extracted");
    expect(body.message).toBe('"redrivePolicy" is not a code symbol in the graph; source files that mention it:');
    expect(body.textMatches.map((m: { path: string }) => m.path)).toEqual([
      "lib/plugins/aws/events/sqs.js", "lib/plugins/aws/package/compile.js",
    ]);
    expect(body.textMatches[1]).toEqual({ path: "lib/plugins/aws/package/compile.js", line: 12, snippet: "redrivePolicy: {" });
  });

  it("text lists them on stdout", async () => {
    const text = await run([command, "redrivePolicy"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('"redrivePolicy" is not a code symbol in the graph; source files that mention it:');
    expect(text.stdout).toContain("lib/plugins/aws/events/sqs.js:88");
    expect(text.stdout).not.toContain("CHANGELOG.md");
  });

  it("keeps exit 3 when only docs, changelogs and tests mention it", async () => {
    const json = await run([command, "docsOnlyKey", "--format", "json"]);
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout).error).toBe("unresolved_target");
    const llm = await run([command, "docsOnlyKey", "--format", "llm"]);
    expect(llm.exitCode).toBe(3);
    expect(llm.stdout).toMatch(/^error code=unresolved_target /);
  });

  it("keeps exit 3 when the name is found nowhere", async () => {
    const json = await run([command, "Missing", "--format", "json"]);
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout).error).toBe("unresolved_target");
  });

  it("--strict reports the miss as before", async () => {
    const json = await run([command, "redrivePolicy", "--strict", "--format", "json"]);
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout).error).toBe("unresolved_target");
  });
});

describe.each(["locate", "callers", "impact", "explain"])("ix %s keeps the miss's suggestions", (command) => {
  it("an answer from the text still lists the near code symbols", async () => {
    const llm = await run([command, "nearKey", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    expect(llm.stdout).toMatch(/^note code=text_matches target=nearKey /m);
    expect(llm.stdout).toMatch(/^suggestion n=1 name=loadKeys kind=function path=src\/near\.ts/m);

    const json = JSON.parse((await run([command, "nearKey", "--format", "json"])).stdout);
    expect(json.note).toBe("text_matches");
    expect(json.suggestions).toEqual([{ id: "near-id", name: "loadKeys", kind: "function", path: "src/near.ts" }]);

    const text = await run([command, "nearKey"]);
    expect(text.stdout).toContain("Code symbols with a similar name:");
    expect(text.stdout).toContain("loadKeys");
  });

  it("a qualified name is not answered with its last segment's text; the miss keeps its suggestion", async () => {
    const llm = await run([command, "Router.handle", "--format", "llm"]);
    expect(llm.exitCode).toBe(3);
    expect(llm.stdout).not.toContain("code=text_matches");
    expect(llm.stdout).toMatch(/^error code=unresolved_target /m);
    expect(llm.stdout).toMatch(/^suggestion n=1 name=handle kind=method path=src\/dispatcher\.ts/m);
  });
});

describe("several targets", () => {
  it("an ambiguous target among answered ones is answered with its notice; the run exits 0", async () => {
    const json = await run(["callers", "Duplicate", "Unique", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.summary).toMatchObject({ total: 2, ok: 2, ambiguous: 0 });
    expect(body.targets[0].exitCode).toBe(0);
    expect(body.targets[0].resolutionNotices[0]).toMatchObject({ code: "ambiguous_target", chosen: { id: "first-id" } });
    expect(body.targets[1].resolutionNotices).toBeUndefined();

    const llm = await run(["locate", "Duplicate", "Missing", "--format", "llm"]);
    expect(llm.exitCode).toBe(3);
    expect(llm.stdout.split("\n").pop()).toBe("targets total=2 ok=1 not_found=1");
  });

  it("--all still answers for every candidate", async () => {
    const llm = await run(["callers", "Duplicate", "--all", "--format", "llm"]);
    expect(llm.exitCode).toBe(0);
    expect(llm.stdout).not.toContain("diagnostic code=ambiguous_target");
    expect(llm.stdout).toContain("candidate n=1");
    expect(llm.stdout).toContain("candidate n=2");
  });
});

describe("sourceTextMatches", () => {
  it("puts a line that sets the name first, lists at most 10, and cuts a long line", async () => {
    const { sourceTextMatches, TEXT_MATCH_LIMIT } = await import("../text-matches.js");
    const reads = Array.from({ length: 12 }, (_, i) => ({ path: `src/r${String(i).padStart(2, "0")}.ts`, line: 1, snippet: `use(cfg.timeoutMs)` }));
    const sets = { path: "src/z-config.ts", line: 9, snippet: `  "timeoutMs": 30, // ${"x".repeat(300)}` };
    const rows = sourceTextMatches("timeoutMs", [...reads, sets, { path: "docs/a.ts", line: 1, snippet: "timeoutMs = 1" }]);
    expect(rows).toHaveLength(TEXT_MATCH_LIMIT);
    expect(rows[0].path).toBe("src/z-config.ts");
    expect(rows[0].snippet.length).toBe(160);
    expect(rows[0].snippet.endsWith("…")).toBe(true);
    expect(rows.slice(1).map((r) => r.path)).toEqual(reads.slice(0, 9).map((r) => r.path));
    // `===` reads the name; it does not set it.
    expect(sourceTextMatches("k", [
      { path: "src/a.ts", line: 1, snippet: "if (k === 1) {}" },
      { path: "src/b.ts", line: 1, snippet: "k = 2" },
    ]).map((r) => r.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });
});
