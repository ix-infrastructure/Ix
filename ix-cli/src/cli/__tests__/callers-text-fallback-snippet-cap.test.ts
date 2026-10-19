// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerCallersCommand } from "../commands/callers.js";
import { SNIPPET_MAX_CHARS } from "../commands/text.js";

/**
 * With no graph callers, `ix callers` falls back to a text search and prints
 * each matching line as a snippet. A minified bundle line can be tens of KB,
 * so the fallback caps snippets the way `ix text` does.
 */

const { expand, rgLines } = vi.hoisted(() => ({ expand: vi.fn(), rgLines: { value: [] as string[] } }));

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
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: rgLines.value.join("\n"), stderr: "" });
  },
}));

function match(path: string, line: number, text: string): string {
  const start = Buffer.byteLength(text.slice(0, text.indexOf("foo(")), "utf8");
  return JSON.stringify({
    type: "match",
    data: { path: { text: path }, line_number: line, lines: { text: `${text}\n` }, submatches: [{ match: { text: "foo" }, start, end: start + 3 }] },
  });
}

async function run(args: string[]): Promise<string[]> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await program.parseAsync(["callers", "foo", ...args], { from: "user" });
  return out;
}

describe("ix callers text fallback caps long snippets", () => {
  const long = `${"a".repeat(20_000)};foo(1);${"b".repeat(20_000)}`;

  beforeEach(() => {
    expand.mockReset();
    expand.mockResolvedValue({ nodes: [], edges: [] });
    rgLines.value = [match("dist/bundle.min.js", 1, long), match("src/a.ts", 3, "foo(2);")];
  });
  afterEach(() => vi.restoreAllMocks());

  it("json: a minified line is clipped around the match; a short line is unchanged", async () => {
    const out = JSON.parse((await run(["--format", "json"])).join("\n"));
    const snippets = new Map<string, string>(out.results.map((r: any) => [r.path, r.attrs.snippet]));
    const clipped = snippets.get("dist/bundle.min.js")!;
    expect(clipped.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 2);
    expect(clipped).toContain("foo(1)");
    expect(clipped.startsWith("…")).toBe(true);
    expect(snippets.get("src/a.ts")).toBe("foo(2);");
  });

  it("llm: no row carries the whole line", async () => {
    const out = await run(["--format", "llm"]);
    expect(out.join("\n")).not.toContain("a".repeat(1000));
    expect(out.some((l) => l.includes("foo(1)"))).toBe(true);
  });
});
