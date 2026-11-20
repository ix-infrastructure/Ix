// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// A name that is no code symbol but appears in source files is answered with
// those files, exit 0 (text-matches.ts). `ix context X --out f` / `--save id`
// promise a bundle, and a file list is not one: there the name stays the miss
// (exit 3), so `ix context X --out f && use f` never sees success with no file.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search() { return []; }
    async entity() { return { node: null }; }
    async listByKind() { return []; }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => true,
  explainSymbolMiss: async (_client: unknown, symbol: string) => symbol === "redrivePolicy"
    ? {
      reason: "symbol_not_extracted",
      message: '"redrivePolicy" is not in the graph.',
      files: ["lib/plugins/aws/events/sqs.js"],
      matches: [{ path: "lib/plugins/aws/events/sqs.js", line: 88, snippet: "const redrivePolicy = event.redrivePolicy;" }],
    }
    : null,
}));

vi.mock("../target-suggestions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../target-suggestions.js")>(),
  findTargetCandidates: async () => ({ didYouMean: [], suggestions: [] }),
}));

let home: string;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-context-text-only-"));
  process.env.IX_HOME = home;
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(home, { recursive: true, force: true });
  process.exitCode = priorExitCode;
});

async function context(args: string[]): Promise<{ stdout: string; out: string; exitCode: typeof process.exitCode }> {
  const { registerContextCommand } = await import("../commands/context.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerContextCommand(program);
  const stdout: string[] = [];
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...p) => { stdout.push(p.join(" ")); lines.push(p.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...p) => { lines.push(p.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((p: string) => { lines.push(String(p)); return true; }) as never);
  try {
    await program.parseAsync(["node", "ix", "context", ...args]).catch(() => undefined);
  } finally {
    log.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout: stdout.join("\n"), out: lines.join("\n"), exitCode };
}

describe("ix context on a name found only as source text", () => {
  it("answers with the text matches, exit 0, without --out or --save", async () => {
    const { stdout, exitCode } = await context(["redrivePolicy", "--format", "json"]);
    expect(JSON.parse(stdout).note).toBe("text_matches");
    expect(exitCode ?? 0).toBe(0);
  });

  it("--out is the miss (exit 3) and writes no file", async () => {
    const file = join(home, "bundle.json");
    const { out, exitCode } = await context(["redrivePolicy", "--out", file]);
    expect(exitCode).toBe(3);
    expect(out).toContain('No entity found matching "redrivePolicy"');
    expect(out).not.toContain("not a code symbol in the graph; source files that mention it");
    expect(existsSync(file)).toBe(false);
  });

  it("--save is the miss (exit 3) and saves no investigation", async () => {
    const { out, exitCode } = await context(["redrivePolicy", "--save", "inv", "--format", "json"]);
    expect(exitCode).toBe(3);
    expect(out).toContain("unresolved_target");
    expect(out).not.toContain("text_matches");
    const saved = join(home, "investigations");
    expect(existsSync(saved) ? readdirSync(saved) : []).toEqual([]);
  });
});
