// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { clipSnippet, registerTextCommand, SNIPPET_MAX_CHARS as CAP } from "../commands/text.js";

function sub(text: string, needle: string) {
  const start = Buffer.byteLength(text.slice(0, text.indexOf(needle)));
  return [{ start, end: start + Buffer.byteLength(needle) }];
}
function clip(text: string, needle = "needle") {
  return clipSnippet(text, sub(text, needle));
}
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("clipSnippet", () => {
  it("clips a 50 KB line around the match", () => {
    const t = "x".repeat(25000) + "needle" + "y".repeat(25000) + "\n";
    const r = clip(t);
    expect(r.length).toBeLessThanOrEqual(CAP + 2);
    expect(r.startsWith("…")).toBe(true);
    expect(r.endsWith("…")).toBe(true);
    expect(r).toContain("needle");
  });
  it("leaves short lines and lines at the cap unchanged", () => {
    expect(clip("const needle = 1;\n")).toBe("const needle = 1;\n");
    const exact = "a".repeat(CAP - 6) + "needle";
    expect(clip(exact + "\n")).toBe(exact + "\n");
    expect(clip(exact + "z\n")).not.toBe(exact + "z\n");
  });
  it("marks only the cut side", () => {
    const head = clip("needle" + "y".repeat(5000) + "\n");
    expect(head.startsWith("needle")).toBe(true);
    expect(head.endsWith("…")).toBe(true);
    const tail = clip("x".repeat(5000) + "needle end\n");
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("needle end\n")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(CAP + 2);
  });
  it("maps byte offsets and keeps surrogate pairs whole", () => {
    for (const filler of ["é", "😀", "日"]) {
      const t = filler.repeat(5000) + "needle" + filler.repeat(5000) + "\n";
      const r = clip(t);
      expect(r).toContain("needle");
      expect(r).not.toMatch(lone);
      expect(r.length).toBeLessThanOrEqual(CAP + 2);
    }
    const odd = "a" + "😀".repeat(3000) + "needle" + "😀".repeat(3000);
    expect(clip(odd)).not.toMatch(lone);
  });
  it("keeps the head when submatches are missing or out of range", () => {
    const t = "x".repeat(5000) + "\n";
    for (const subs of [undefined, [], [{ start: 99999, end: 100000 }], [{}]]) {
      const r = clipSnippet(t, subs);
      expect(r.startsWith("x")).toBe(true);
      expect(r.endsWith("…")).toBe(true);
      expect(r.length).toBeLessThanOrEqual(CAP + 1);
    }
  });
  it("caps a match longer than the cap", () => {
    const t = "z".repeat(50000) + "\n";
    const r = clipSnippet(t, [{ start: 0, end: 50000 }]);
    expect(r).toBe("z".repeat(CAP) + "…");
  });
});

describe("ix text snippet cap end to end", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  async function run(format: string) {
    const text = "é".repeat(25000) + "needle" + "y".repeat(25000) + "\n";
    const line = JSON.stringify({ type: "match", data: {
      path: { text: "a.ts" }, line_number: 3, lines: { text }, submatches: [{ match: { text: "needle" }, ...sub(text, "needle")[0] }],
    } });
    const program = new Command();
    registerTextCommand(program, async () => ({ stdout: line + "\n" }));
    await program.parseAsync(["text", "needle", "--format", format], { from: "user" });
    return log.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }
  it("json keeps its shape", async () => {
    const out = JSON.parse(await run("json"));
    expect(Object.keys(out[0])).toEqual(["path", "line_start", "line_end", "snippet", "engine", "score", "language"]);
    expect(out[0].snippet.length).toBeLessThanOrEqual(CAP + 2);
    expect(out[0].snippet).toContain("needle");
  });
  it.each(["text", "llm"])("%s output is bounded", async format => {
    const out = await run(format);
    expect(out).toContain("needle");
    expect(Math.max(...out.split("\n").map((l: string) => l.length))).toBeLessThan(CAP + 200);
  });
});
