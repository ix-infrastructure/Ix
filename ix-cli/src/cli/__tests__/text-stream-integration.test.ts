import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTextCommand } from "../commands/text.js";

const hasRipgrep = spawnSync("rg", ["--version"]).status === 0;
const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe.skipIf(!hasRipgrep)("text streaming with real ripgrep", () => {
  it("returns the requested matches when per-file output exceeds 10 MiB", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ix-text-stream-"));
    fixtures.push(root);
    for (let i = 0; i < 128; i++) {
      writeFileSync(path.join(root, `${i}.ts`), `needle ${"x".repeat(100_000)}\n`);
    }
    const raw = execFileSync("rg", ["--json", "--max-count", "20", "--", "needle", root], {
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(raw.length).toBeGreaterThan(10 * 1024 * 1024);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("unexpected exit"); });
    const program = new Command();
    registerTextCommand(program);
    await program.parseAsync(["text", "needle", "--root", root, "--format", "json"], { from: "user" });
    const results = JSON.parse(log.mock.calls.map(call => call.join(" ")).join("\n"));
    expect(results).toHaveLength(20);
    expect(new Set(results.map((r: { path: string }) => r.path)).size).toBe(20);
    expect(results[0]).toMatchObject({ engine: "ripgrep", line_start: 1 });
  });
});
