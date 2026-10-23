// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const listByKind = vi.hoisted(() => vi.fn());
vi.mock("../../client/factory.js", () => ({ createClient: () => ({ listByKind }) }));
vi.mock("../resolve.js", () => ({ resolveReadSystemId: async () => undefined }));
vi.mock("../bootstrap.js", () => ({ resolveWorkspaceId: () => "ws" }));

import {
  formatTextResults, renderEdgeResultsLlm, renderTextResultsLlm, sliceEdgeResults, sliceRanked, truncationHint,
  type TextResult,
} from "../format.js";
import { IX_CALLER_ENV } from "../next-step.js";
import { nextPageCommand, shellQuote } from "../paging.js";
import { LIST_MAX_ROWS, registerInventoryCommand, renderInventoryLlm } from "../commands/inventory.js";
import { compareTextResults, keepTopK, SCAN_WINDOW_MAX, scanWindow, textResultPriority } from "../commands/text.js";

function node(name: string, path?: string) {
  return { id: `${name}-0000-0000-0000-000000000000`, name, kind: "function", ...(path ? { provenance: { source_uri: path } } : {}) };
}

describe("sliceRanked", () => {
  it("reports the count before the cut, not after it", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`caller${i}`, "src/a.ts"));
    const slice = sliceRanked(all, 50);
    expect(slice.shown).toBe(50);
    expect(slice.total).toBe(212);
    expect(slice.truncated).toBe(true);
  });

  it("is not truncated when everything fits", () => {
    const slice = sliceRanked([node("a", "src/a.ts")], 50);
    expect(slice).toMatchObject({ shown: 1, total: 1, truncated: false });
  });

  it("keeps the source order among rows that rank equally", () => {
    const all = [node("b", "src/b.ts"), node("a", "src/a.ts")];
    expect(sliceRanked(all, 10, () => 0).rows.map((n) => n.name)).toEqual(["b", "a"]);
  });

  it("does not mutate the caller's array", () => {
    const all = [node("b", "src/b.ts"), node("a")];
    const copy = [...all];
    sliceRanked(all, 10, (n) => (n.provenance ? 0 : 1));
    expect(all).toEqual(copy);
  });
});

describe("sliceEdgeResults", () => {
  it("keeps followable rows over dangling ones when the cut bites", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method" },
      { id: "cccccccc-3333-0000-0000-000000000000", name: "verify", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const rows = sliceEdgeResults(all, 2).rows.map((n) => n.name);
    expect(rows).toEqual(["verify", "handleLogin"]);
  });

  it("still reports the rows it dropped", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const header = renderEdgeResultsLlm(sliceEdgeResults(all, 1), "callers", "verify_token", "graph")[0];
    expect(header).toBe("callers target=verify_token shown=1 total=2 resolved=1");
  });

  it("names the next page when the command set one", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`c${i}`, "src/a.ts"));
    const s = { ...sliceEdgeResults(all, 50), next: "ix callers verify_token --offset 50" };
    const lines = renderEdgeResultsLlm(s, "callers", "verify_token", "graph");
    expect(lines[1]).toBe(
      'diagnostic code=results_truncated next_offset=50 message="212 callers; showing 50. next: ix callers verify_token --offset 50"',
    );
  });

  it("never points at --offset when the command did not opt into paging", () => {
    // `ix impact` slices its leaf rows with sliceEdgeResults but has no --offset.
    const all = Array.from({ length: 25 }, (_, i) => node(`c${i}`, "src/a.ts"));
    const s = sliceEdgeResults(all, 10);
    expect(s.nextOffset).toBe(10);
    expect(truncationHint(s, "callers")).toBe("25 callers; showing 10. Raise --limit to see them.");
    const capped = sliceEdgeResults(Array.from({ length: 1000 }, (_, i) => node(`c${i}`, "src/a.ts")), 10, 0, true);
    expect(truncationHint(capped, "callers")).not.toContain("--offset");
  });
});

describe("paging with --offset", () => {
  const mixed = () => [
    ...Array.from({ length: 70 }, (_, i) => node(`p${i}`, "src/a.ts")),
    ...Array.from({ length: 70 }, (_, i) => node(`n${i}`)),
    ...Array.from({ length: 72 }, (_, i) => ({ id: `${i.toString(16).padStart(8, "0")}-1111-0000-0000-000000000000`, name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" })),
  ];

  it("pages concatenate to the full ranked list with no overlap or gap", () => {
    const all = mixed();
    const full = sliceEdgeResults(all, Infinity).rows;
    const got: any[] = [];
    let offset = 0;
    for (;;) {
      const s = sliceEdgeResults(all, 50, offset);
      got.push(...s.rows);
      if (s.nextOffset === undefined) break;
      offset = s.nextOffset;
    }
    expect(got).toEqual(full);
    expect(new Set(got.map((n) => n.id)).size).toBe(212);
  });

  it("a middle page names the next offset", () => {
    const s = sliceEdgeResults(mixed(), 50, 50);
    expect(s).toMatchObject({ offset: 50, shown: 50, total: 212, truncated: true, nextOffset: 100 });
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines[0]).toBe("callers target=t offset=50 shown=50 total=212 resolved=50");
    expect(lines[1]).toContain("next_offset=100");
    expect(lines[1]).toContain("showing 51-100. Raise --limit");
    const paged = renderEdgeResultsLlm({ ...s, next: "ix callers t --offset 100" }, "callers", "t", "graph");
    expect(paged[1]).toContain("showing 51-100. next: ix callers t --offset 100");
  });

  it("uses the caller's next command when given", () => {
    const s = { ...sliceEdgeResults(mixed(), 50), next: "ix callers t --offset 50" };
    expect(renderEdgeResultsLlm(s, "callers", "t", "graph")[1]).toContain("next: ix callers t --offset 50");
  });

  it("the last page has no hint", () => {
    const s = sliceEdgeResults(mixed(), 50, 200);
    expect(s).toMatchObject({ shown: 12, truncated: false });
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.includes("results_truncated"))).toBe(false);
  });

  it("past the end says so instead of no_edges", () => {
    const s = sliceEdgeResults(mixed(), 50, 300);
    expect(s).toMatchObject({ rows: [], total: 212, truncated: false });
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.startsWith("diagnostic code=offset_past_end"))).toBe(true);
    expect(lines.some((l) => l.includes("no_edges"))).toBe(false);
  });

  it("--limit 0 gives no next offset and does not claim past-the-end", () => {
    const s = sliceEdgeResults(mixed().slice(0, 5), 0);
    expect(s).toMatchObject({ rows: [], shown: 0, total: 5, truncated: true });
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines[1]).toBe('diagnostic code=results_truncated message="5 callers; showing 0. Raise --limit to see them."');
    expect(lines.some((l) => l.includes("offset_past_end") || l.includes("no_edges"))).toBe(false);
  });

  it("an offset with --limit 0 is not past the end while rows remain", () => {
    const s = sliceEdgeResults(mixed(), 0, 50);
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.includes("offset_past_end"))).toBe(false);
  });

  it("--limit 0 past the first page prints the count, not an inverted range", () => {
    const s = sliceEdgeResults(mixed(), 0, 50);
    expect(s).toMatchObject({ offset: 50, shown: 0, total: 212, truncated: true });
    expect(truncationHint(s, "callers")).toBe("212 callers; showing 0. Raise --limit to see them.");
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines[1]).toBe('diagnostic code=results_truncated message="212 callers; showing 0. Raise --limit to see them."');
    expect(lines.join("\n")).not.toContain("51-50");
    expect(lines.join("\n")).not.toContain("next_offset");
  });

  it("leaves the header and rows alone without an offset", () => {
    const lines = renderEdgeResultsLlm(sliceEdgeResults([node("a", "src/a.ts")], 50), "callers", "t", "graph");
    expect(lines[0]).toBe("callers target=t shown=1 total=1 resolved=1");
    expect(lines).toHaveLength(2);
  });
});

describe("nextPageCommand", () => {
  function parsed(argv: string[]): Command {
    const cmd = new Command("callers")
      .argument("<symbol>")
      .option("--limit <n>", "", "50")
      .option("--kind <kind>")
      .option("--offset <n>", "", "0")
      .exitOverride();
    cmd.parse(argv, { from: "user" });
    return cmd;
  }

  it("keeps only typed options and drops --offset", () => {
    const cmd = parsed(["--kind", "method", "--offset", "50", "x"]);
    expect(nextPageCommand(cmd, ["x"], 100)).toBe("ix callers --kind method --offset 100 x");
  });

  it("quotes a symbol with a space and guards a leading dash", () => {
    const cmd = parsed(["a b"]);
    expect(nextPageCommand(cmd, ["a b"], 50)).toBe("ix callers --offset 50 'a b'");
    expect(nextPageCommand(cmd, ["-x"], 50)).toBe("ix callers --offset 50 -- -x");
  });

  it("over MCP names the tool's offset input, not a CLI command", () => {
    const cmd = parsed(["--kind", "method", "x"]);
    const prev = process.env[IX_CALLER_ENV];
    process.env[IX_CALLER_ENV] = "mcp";
    try {
      expect(nextPageCommand(cmd, ["x"], 50)).toBe("offset=50");
    } finally {
      if (prev === undefined) delete process.env[IX_CALLER_ENV];
      else process.env[IX_CALLER_ENV] = prev;
    }
  });
});

describe("shellQuote", () => {
  it("uses POSIX quoting off Windows", () => {
    expect(shellQuote("it's", "linux")).toBe(`'it'\\''s'`);
  });

  it("doubles an embedded quote on Windows (PowerShell)", () => {
    expect(shellQuote("it's", "win32")).toBe("'it''s'");
    expect(shellQuote("a b", "win32")).toBe("'a b'");
  });

  it("leaves a safe word bare on every platform", () => {
    expect(shellQuote("src/a.ts", "win32")).toBe("src/a.ts");
    expect(shellQuote("src/a.ts", "darwin")).toBe("src/a.ts");
  });
});

describe("renderInventoryLlm", () => {
  it("says shown, and marks a full window rather than inventing a total", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes, true).slice(0, 2)).toEqual([
      "inventory kind=class shown=1 truncated=true",
      'diagnostic code=results_truncated message="More than 1 class entities exist. Raise --limit, or narrow with --path."',
    ]);
  });

  it("says nothing about truncation when the window was not full", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes)[0]).toBe("inventory kind=class shown=1");
  });

  it("a middle page names its offset and the next one", () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({ name: `C${i}`, kind: "class", provenance: { source_uri: "src/a.ts" } }));
    const lines = renderInventoryLlm("class", null, nodes, true, {
      offset: 50, nextOffset: 100, next: "ix inventory --kind class --offset 100",
    });
    expect(lines.slice(0, 2)).toEqual([
      "inventory kind=class offset=50 shown=50 truncated=true",
      'diagnostic code=results_truncated next_offset=100 message="More than 100 class entities exist. next: ix inventory --kind class --offset 100, or narrow with --path."',
    ]);
  });

  it("keeps the first-page header as it was with offset 0", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes, true, { offset: 0 })[0]).toBe("inventory kind=class shown=1 truncated=true");
  });

  it("past the end says so", () => {
    const lines = renderInventoryLlm("class", null, [], false, { offset: 500 });
    expect(lines).toEqual([
      "inventory kind=class offset=500 shown=0",
      'diagnostic code=offset_past_end message="Fewer than 501 class entities exist; --offset 500 is past the end."',
    ]);
  });
});

describe("ix inventory --offset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listByKind.mockReset();
  });

  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({ name: `C${i + 1}`, kind: "class", provenance: { source_uri: "src/a.ts" } }));
  }

  async function run(argv: string[]): Promise<string[]> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    log.mockClear();
    const program = new Command();
    registerInventoryCommand(program);
    await program.parseAsync(["inventory", "--kind", "class", ...argv], { from: "user" });
    return log.mock.calls.map((c) => String(c[0]));
  }

  it("fetches offset+limit+1 rows and prints the page after the offset", async () => {
    listByKind.mockResolvedValue(rows(5));
    const out = await run(["--offset", "2", "--limit", "2", "--format", "json"]);
    expect(listByKind).toHaveBeenCalledWith("class", expect.objectContaining({ limit: 5 }));
    const json = JSON.parse(out[0]);
    expect(json).toMatchObject({ offset: 2, shown: 2, truncated: true, nextOffset: 4 });
    expect(json.byFile).toEqual([{ path: "src/a.ts", items: ["C3", "C4"] }]);
  });

  it("has no next offset when no row is left after the page", async () => {
    listByKind.mockResolvedValue(rows(4));
    const json = JSON.parse((await run(["--offset", "2", "--limit", "2", "--format", "json"]))[0]);
    expect(json).toMatchObject({ offset: 2, shown: 2, truncated: false });
    expect(json).not.toHaveProperty("nextOffset");
  });

  it("asks for no more than the server's row cap", async () => {
    listByKind.mockResolvedValue(rows(10));
    await run(["--offset", "4990", "--limit", "50", "--format", "json"]);
    expect(listByKind).toHaveBeenCalledWith("class", expect.objectContaining({ limit: LIST_MAX_ROWS }));
  });

  it("an offset at or past the server cap is not past the end", async () => {
    listByKind.mockResolvedValue(rows(LIST_MAX_ROWS));
    for (const offset of ["5000", "6000"]) {
      const out = await run(["--offset", offset, "--limit", "50", "--format", "llm"]);
      expect(out[0]).toBe(`inventory kind=class offset=${offset} shown=0 truncated=true`);
      expect(out[1]).toBe(
        `diagnostic code=results_truncated message="The server returns at most 5000 class entities, so how many exist is unknown; --offset ${offset} is beyond the rows it returns. Narrow with --path (or a more specific --kind) to see the rest."`,
      );
      expect(out.join("\n")).not.toContain("offset_past_end");
    }
  });

  it("the page that reaches the server cap stays truncated with no next page", async () => {
    listByKind.mockResolvedValue(rows(LIST_MAX_ROWS));
    const json = JSON.parse((await run(["--offset", "4990", "--limit", "50", "--format", "json"]))[0]);
    expect(json).toMatchObject({ offset: 4990, shown: 10, truncated: true, capped: true });
    expect(json).not.toHaveProperty("nextOffset");
    const llm = await run(["--offset", "4990", "--limit", "50", "--format", "llm"]);
    expect(llm[1]).toContain("this page ends at row 5000, the last it returns");
  });

  it("a --limit over the cap does not read a full server answer as the whole list", async () => {
    listByKind.mockResolvedValue(rows(LIST_MAX_ROWS));
    const json = JSON.parse((await run(["--limit", "10000", "--format", "json"]))[0]);
    expect(json).toMatchObject({ shown: LIST_MAX_ROWS, truncated: true, capped: true });
  });

  it("a short answer to a request over the cap is the whole list", async () => {
    listByKind.mockResolvedValue(rows(4995));
    const out = await run(["--offset", "6000", "--limit", "50", "--format", "llm"]);
    expect(out[1]).toContain("code=offset_past_end");
    const json = JSON.parse((await run(["--offset", "4990", "--limit", "50", "--format", "json"]))[0]);
    expect(json).toMatchObject({ shown: 5, truncated: false });
    expect(json).not.toHaveProperty("capped");
  });

  it("text mode names the cap on an empty page past it", async () => {
    listByKind.mockResolvedValue(rows(LIST_MAX_ROWS));
    const out = await run(["--offset", "5000"]);
    expect(out[0]).toContain("The server returns at most 5000 class entities");
  });

  it("names the next command in llm output, repeating --limit", async () => {
    listByKind.mockResolvedValue(rows(5));
    const out = await run(["--offset", "2", "--limit", "2", "--format", "llm"]);
    expect(out[0]).toBe("inventory kind=class offset=2 shown=2 truncated=true");
    expect(out[1]).toContain("next_offset=4");
    expect(out[1]).toContain("next: ix inventory --kind class --limit 2 --format llm --offset 4");
  });
});

describe("text result ranking", () => {
  it("scans past the limit so ranking has something to rank", () => {
    expect(scanWindow(20)).toBe(100);
    expect(scanWindow(1)).toBe(5);
    expect(scanWindow(400)).toBe(500);
  });

  it("widens the scan window with --offset, up to the cap", () => {
    expect(scanWindow(20, 0)).toBe(100);
    expect(scanWindow(20, 100)).toBe(200);
    expect(scanWindow(20, 460)).toBe(SCAN_WINDOW_MAX);
    expect(scanWindow(20, 10_000)).toBe(SCAN_WINDOW_MAX);
  });

  it("puts code above tests, and tests above prose", () => {
    expect(textResultPriority("ix-cli/src/cli/format.ts")).toBe(0);
    expect(textResultPriority("ix-cli/src/cli/__tests__/format.test.ts")).toBe(1);
    expect(textResultPriority("ix-cli/test/fixtures/a.ts")).toBe(1);
    expect(textResultPriority("README.md")).toBe(2);
    expect(textResultPriority("docs/api/README.md")).toBe(2);
    expect(textResultPriority("package-lock.json")).toBe(2);
  });

  it("reorders the answer before the limit cuts it", () => {
    const rows = [
      { path: "README.md", line_start: 1, line_end: 1, snippet: "a", engine: "ripgrep", score: 1 },
      { path: "docs/guide.md", line_start: 2, line_end: 2, snippet: "b", engine: "ripgrep", score: 1 },
      { path: "src/a.ts", line_start: 3, line_end: 3, snippet: "c", engine: "ripgrep", score: 1 },
    ];
    const slice = sliceRanked(rows, 1, (r) => textResultPriority(r.path));
    expect(slice.rows.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(slice.total).toBe(3);
  });

  it("orders code before tests before prose, then by path, then by line", () => {
    const rows = [
      text("README.md", 1), text("src/b.ts", 9), text("src/__tests__/a.test.ts", 1),
      text("src/b.ts", 2), text("src/a.ts", 5), text("docs/a.md", 1),
    ];
    expect([...rows].sort(compareTextResults).map((r) => `${r.path}:${r.line_start}`)).toEqual([
      "src/a.ts:5", "src/b.ts:2", "src/b.ts:9", "src/__tests__/a.test.ts:1", "README.md:1", "docs/a.md:1",
    ]);
  });

  it("keepTopK keeps the best k, in order, with ties in arrival order", () => {
    const rows = [text("docs/a.md", 1, "x"), text("src/a.ts", 1, "first"), text("src/a.ts", 1, "second")];
    expect(keepTopK(rows, 2, compareTextResults).map((r) => r.snippet)).toEqual(["first", "second"]);
    expect(keepTopK(rows, 0, compareTextResults)).toEqual([]);
  });

  it("pages of one ranked list are disjoint and add up to its head", () => {
    const all = Array.from({ length: 100 }, (_, i) => text(`src/f${String(i).padStart(3, "0")}.ts`, 1)).sort(compareTextResults);
    const pages = [0, 20, 40].map((offset) => sliceRanked(all, 20, undefined, offset).rows);
    const union = pages.flat();
    expect(new Set(union.map((r) => r.path)).size).toBe(60);
    expect(union).toEqual(all.slice(0, 60));
  });
});

function text(path: string, line: number, snippet = "needle"): TextResult {
  return { path, line_start: line, line_end: line, snippet, engine: "ripgrep", score: 1 };
}

describe("renderTextResultsLlm paging", () => {
  const all = Array.from({ length: 100 }, (_, i) => text(`src/f${String(i).padStart(3, "0")}.ts`, 1));

  it("leaves the first-page header alone", () => {
    const lines = renderTextResultsLlm(sliceRanked(all, 20));
    expect(lines[0]).toBe("text shown=20 scanned=100 truncated=true");
    expect(lines[1]).toBe('diagnostic code=results_truncated next_offset=20 message="100 matches scanned; showing 20. next: --offset 20"');
  });

  it("a middle page names its offset and the next command", () => {
    const slice = { ...sliceRanked(all, 20, undefined, 20), next: "ix text --limit 20 --offset 40 needle" };
    const lines = renderTextResultsLlm(slice, { windowFull: true });
    expect(lines[0]).toBe("text offset=20 shown=20 scanned=100 truncated=true");
    expect(lines[1]).toBe('diagnostic code=results_truncated next_offset=40 message="100 matches scanned; showing 21-40. next: ix text --limit 20 --offset 40 needle"');
  });

  it("the page that reaches the end of a full window says to narrow instead", () => {
    const lines = renderTextResultsLlm(sliceRanked(all, 20, undefined, 80), { windowFull: true });
    expect(lines[0]).toBe("text offset=80 shown=20 scanned=100 truncated=true");
    expect(lines[1]).toBe('diagnostic code=results_truncated message="100 matches scanned; showing 81-100; the scan stops at 100. Narrow with --path or --language, or raise --limit."');
    expect(lines.join("\n")).not.toContain("next_offset");
  });

  it("the last page of a window that held every match has no hint", () => {
    const lines = renderTextResultsLlm(sliceRanked(all, 20, undefined, 80));
    expect(lines[0]).toBe("text offset=80 shown=20 scanned=100");
    expect(lines.some((l) => l.startsWith("diagnostic"))).toBe(false);
  });

  it("past the end of a window that held every match says so", () => {
    const lines = renderTextResultsLlm(sliceRanked(all, 20, undefined, 120));
    expect(lines).toEqual([
      "text offset=120 shown=0 scanned=100",
      'diagnostic code=offset_past_end message="100 matches scanned; --offset 120 is past the end."',
    ]);
  });

  it("past a full window is not past the end: it stays truncated and says to narrow", () => {
    for (const offset of [100, 120]) {
      const lines = renderTextResultsLlm(sliceRanked(all, 20, undefined, offset), { windowFull: true });
      expect(lines).toEqual([
        `text offset=${offset} shown=0 scanned=100 truncated=true`,
        `diagnostic code=results_truncated message="100 matches scanned; --offset ${offset} is past the scan window, which stops at 100. Narrow with --path or --language, or raise --limit."`,
      ]);
    }
  });

  it("text mode prints the narrow hint, not past-the-end, past a full window", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      formatTextResults(sliceRanked(all, 20, undefined, 100), "text", { windowFull: true });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("is past the scan window, which stops at 100");
      expect(out).not.toContain("is past the end");
    } finally {
      log.mockRestore();
    }
  });
});
