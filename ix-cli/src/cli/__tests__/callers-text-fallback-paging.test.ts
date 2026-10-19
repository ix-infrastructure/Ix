// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerCallersCommand, TEXT_FALLBACK_PAGE } from "../commands/callers.js";

/**
 * With no graph callers, `ix callers` falls back to a text search. That
 * fallback used to print a fixed first 10 rows whatever --offset said, so a
 * caller following the paging hint saw page 1 again. It now pages the same
 * ranked list the way the graph path does.
 */

const { expand, rgMatches } = vi.hoisted(() => ({ expand: vi.fn(), rgMatches: { value: [] as Array<[string, number, string]> } }));

vi.mock("../../client/factory.js", () => ({
  createClient: () => ({ expand: (...args: unknown[]) => expand(...args) }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: async () => ({ id: "11111111-0000-0000-0000-000000000000", kind: "function", name: "foo", resolutionMode: "exact" }),
  printResolved: () => {},
}));
vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: async () => ({ status: "healthy" }),
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  resolveWorkspaceRoot: () => "/ws",
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  // promisify(execFile) resolves with the callback's value.
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    // Emitted in reverse order: rg's order varies between runs and the command must not depend on it.
    const stdout = [...rgMatches.value].reverse().map(([path, line, text]) => JSON.stringify({
      type: "match", data: { path: { text: path }, line_number: line, lines: { text: `${text}\n` } },
    })).join("\n");
    cb(null, { stdout, stderr: "" });
  },
}));

/** `count` call sites of foo, one per file. */
function calls(count: number): Array<[string, number, string]> {
  return Array.from({ length: count }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, i + 1, `foo(${i});`]);
}

async function run(args: string[]): Promise<{ out: string[]; err: string[] }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; });
  await program.parseAsync(["callers", "foo", ...args], { from: "user" });
  return { out, err };
}

const refs = (out: string[]) => out.filter((l) => l.startsWith("ref "));

describe("ix callers text fallback paging", () => {
  beforeEach(() => {
    expand.mockReset();
    expand.mockResolvedValue({ nodes: [], edges: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("page 1 and page 2 make up the full list with no overlap", async () => {
    rgMatches.value = calls(15);
    const p1 = await run(["--format", "llm"]);
    const p2 = await run(["--offset", "10", "--format", "llm"]);

    expect(p1.out[0]).toBe("callers target=foo source=text shown=10 total=15");
    expect(p1.out).toContain(
      'diagnostic code=results_truncated next_offset=10 message="15 text candidates; showing 10. next: ix callers --format llm --offset 10 foo"',
    );
    expect(p2.out[0]).toBe("callers target=foo source=text offset=10 shown=5 total=15");
    expect(p2.out.some((l) => l.includes("results_truncated") || l.includes("offset_past_end"))).toBe(false);

    const all = [...refs(p1.out), ...refs(p2.out)];
    expect(refs(p1.out)).toHaveLength(TEXT_FALLBACK_PAGE);
    expect(new Set(all).size).toBe(15);
    expect(all.map((l) => /path=(\S+)/.exec(l)?.[1])).toEqual(calls(15).map(([p]) => p));
  });

  it("json pages carry offset, truncated and nextOffset", async () => {
    rgMatches.value = calls(15);
    const p1 = JSON.parse((await run(["--format", "json"])).out.join("\n"));
    const p2 = JSON.parse((await run(["--offset", "10", "--format", "json"])).out.join("\n"));
    expect(p1.summary).toEqual({ candidatesFound: 15, candidatesReturned: 10, truncated: true, nextOffset: 10 });
    expect(p2.summary).toEqual({ candidatesFound: 15, candidatesReturned: 5, offset: 10 });
    const lines = [...p1.results, ...p2.results].map((r: { line: number }) => r.line);
    expect(lines).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it("text page 1 points at page 2", async () => {
    rgMatches.value = calls(15);
    const { err } = await run([]);
    expect(err.join("")).toContain("(15 total candidates; showing 10) next: ix callers --offset 10 foo");
    const p2 = await run(["--offset", "10"]);
    expect(p2.out.filter((l) => l.includes("foo("))).toHaveLength(5);
    expect(p2.err.join("")).toContain("(15 total candidates; showing 11-15)");
  });

  it("an offset past the end says so in every format", async () => {
    rgMatches.value = calls(15);
    const llm = await run(["--offset", "15", "--format", "llm"]);
    expect(llm.out[0]).toBe("callers target=foo source=text offset=15 shown=0 total=15");
    expect(llm.out).toContain('diagnostic code=offset_past_end message="15 text candidates; --offset 15 is past the end."');
    expect(llm.out.some((l) => l.includes("no_edges") || l.includes("results_truncated"))).toBe(false);

    const json = JSON.parse((await run(["--offset", "40", "--format", "json"])).out.join("\n"));
    expect(json.results).toEqual([]);
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["text_fallback_used", "offset_past_end"]);

    const text = await run(["--offset", "15"]);
    expect(text.out).toEqual(["15 text candidates; --offset 15 is past the end."]);
  });

  it("the last full page is not called past the end", async () => {
    rgMatches.value = calls(20);
    const llm = await run(["--offset", "10", "--format", "llm"]);
    expect(refs(llm.out)).toHaveLength(10);
    expect(llm.out.some((l) => l.includes("offset_past_end") || l.includes("results_truncated"))).toBe(false);
  });

  it("output without --offset is unchanged when the list fits one page", async () => {
    rgMatches.value = calls(3);
    expect((await run(["--format", "llm"])).out).toEqual([
      "callers target=foo source=text shown=3 total=3",
      'diagnostic code=text_fallback_used message="No graph-backed CALLS/REFERENCES edges; showing text matches."',
      "ref path=src/f00.ts line=1 snippet=foo(0);",
      "ref path=src/f01.ts line=2 snippet=foo(1);",
      "ref path=src/f02.ts line=3 snippet=foo(2);",
    ]);
    const json = JSON.parse((await run(["--format", "json"])).out.join("\n"));
    expect(json.summary).toEqual({ candidatesFound: 3, candidatesReturned: 3 });
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["text_fallback_used"]);
    const text = await run([]);
    expect(text.out).toHaveLength(3);
    expect(text.err.join("")).not.toContain("total candidates");
  });
});
