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

import {
  isNonSourceOrphan,
  registerSmellsCommand,
  selectSmells,
  type SmellCandidate,
  type SmellReport,
} from "../commands/smells.js";

function cand(file: string, confidence: number, smell = "has_smell.orphan_file"): SmellCandidate {
  return { file_id: file, file, smell, confidence, signals: { connectivity: 0 }, inference_version: "smell_v1" };
}

function report(candidates: SmellCandidate[]): SmellReport {
  return { rev: 7, run_at: "2026-10-11T00:00:00Z", count: candidates.length, candidates };
}

/** n source candidates with distinct confidences, deliberately not in order. */
function synthetic(n: number): SmellCandidate[] {
  return Array.from({ length: n }, (_, i) => cand(`src/f${i}.ts`, ((i * 37) % n) / n));
}

describe("isNonSourceOrphan shell dotfiles", () => {
  it("keeps .bashrc and .zshrc", () => {
    expect(isNonSourceOrphan(cand(".bashrc", 0.5))).toBe(false);
    expect(isNonSourceOrphan(cand("home/.zshrc", 0.5))).toBe(false);
    // core-ingestion's languageFromPath parses .zshenv as Bash too.
    expect(isNonSourceOrphan(cand("home/.zshenv", 0.5))).toBe(false);
    expect(isNonSourceOrphan(cand(".gitignore", 0.5))).toBe(true);
  });
});

describe("selectSmells", () => {
  it("keeps the top 50 by confidence out of 120", () => {
    const all = synthetic(120);
    const { slice } = selectSmells(report(all), 50);
    expect(slice.total).toBe(120);
    expect(slice.shown).toBe(50);
    expect(slice.truncated).toBe(true);
    const max = Math.max(...all.map(c => c.confidence));
    expect(slice.rows[0].confidence).toBe(max);
    for (let i = 1; i < slice.rows.length; i++) {
      expect(slice.rows[i - 1].confidence).toBeGreaterThanOrEqual(slice.rows[i].confidence);
    }
  });

  it("is stable among ties", () => {
    const tied = [cand("src/a.ts", 0.5), cand("src/b.ts", 0.9), cand("src/c.ts", 0.5), cand("src/d.ts", 0.5)];
    const { slice } = selectSmells(report(tied), 3);
    expect(slice.rows.map(c => c.file)).toEqual(["src/b.ts", "src/a.ts", "src/c.ts"]);
  });

  it("returns everything for an uncapped limit", () => {
    const { slice } = selectSmells(report(synthetic(120)), Infinity);
    expect(slice.shown).toBe(120);
    expect(slice.truncated).toBe(false);
  });

  it("filters non-source orphans before the cut", () => {
    const rows = [
      cand("README.md", 0.99),
      cand("docs/guide.mdx", 0.98),
      ...synthetic(10),
    ];
    const { slice, filteredNonSource } = selectSmells(report(rows), 5);
    expect(filteredNonSource).toBe(2);
    expect(slice.total).toBe(10);
    expect(slice.shown).toBe(5);
    expect(slice.rows.every(c => c.file.startsWith("src/"))).toBe(true);
  });
});

describe("isNonSourceOrphan", () => {
  it.each(["README.md", "docs/guide.mdx", "templates/page.hbs", "config.yaml", "LICENSE"])(
    "drops orphan %s", (file) => {
      expect(isNonSourceOrphan(cand(file, 0.5))).toBe(true);
    },
  );

  it.each(["src/a.ts", "scripts/run.sh", "Dockerfile", "styles/x.css"])(
    "keeps orphan %s", (file) => {
      expect(isNonSourceOrphan(cand(file, 0.5))).toBe(false);
    },
  );

  it("never drops a god_module or weak_component row", () => {
    expect(isNonSourceOrphan(cand("docs/big.md", 0.9, "has_smell.god_module"))).toBe(false);
    expect(isNonSourceOrphan(cand("docs/big.md", 0.9, "has_smell.weak_component_member"))).toBe(false);
  });
});

describe("ix smells command (mocked client)", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fakeClient.runSmells.mockResolvedValue(report(synthetic(80)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(...args: string[]): Promise<string[]> {
    const program = new Command();
    program.exitOverride();
    registerSmellsCommand(program);
    await program.parseAsync(["smells", ...args], { from: "user" });
    return logs.join("\n").split("\n");
  }

  it("llm: caps at 50 with a truncation diagnostic", async () => {
    const lines = await run("--format", "llm");
    expect(lines[0]).toBe("smells rev=7 count=80 shown=50 version=smell_v1");
    expect(lines[1]).toMatch(/^diagnostic code=results_truncated /);
    expect(lines[1]).toContain("Raise --limit");
    expect(lines.filter(l => l.startsWith("smell ")).length).toBe(50);
  });

  it("text: header counts, 50 rows and the hint", async () => {
    const lines = await run();
    const header = lines.find(l => l.includes("Architecture Smells"))!;
    expect(header).toContain("80 candidates");
    expect(header).toContain("showing 50");
    expect(lines.filter(l => l.includes("src/f")).length).toBe(50);
    expect(lines.some(l => l.includes("Raise --limit"))).toBe(true);
  });

  it("text: --limit 10 prints 10 rows", async () => {
    const lines = await run("--limit", "10");
    expect(lines.filter(l => l.includes("src/f")).length).toBe(10);
  });

  it("text: reports hidden non-source orphans", async () => {
    fakeClient.runSmells.mockResolvedValue(report([cand("README.md", 0.9), cand("src/a.ts", 0.5)]));
    const lines = await run();
    const header = lines.find(l => l.includes("Architecture Smells"))!;
    expect(header).toContain("1 candidates");
    expect(header).toContain("1 non-source orphan files hidden");
    expect(lines.some(l => l.includes("README.md"))).toBe(false);
    expect(lines.some(l => l.includes("Raise --limit"))).toBe(false);
  });

  it("json: uncapped without --limit (MCP path-filter contract)", async () => {
    await run("--format", "json");
    const out = JSON.parse(logs.join("\n"));
    expect(out.candidates.length).toBe(80);
    expect(out.count).toBe(80);
    expect(out.shown).toBe(80);
    expect(out.truncated).toBe(false);
    expect(out.filtered_non_source).toBeUndefined();
  });

  it("json: plain output keeps docs orphans so MCP path queries can match them", async () => {
    fakeClient.runSmells.mockResolvedValue(report([cand("README.md", 0.9), cand("src/a.ts", 0.5)]));
    await run("--format", "json");
    const out = JSON.parse(logs.join("\n"));
    expect(out.candidates.map((c: { file: string }) => c.file)).toEqual(["README.md", "src/a.ts"]);
    expect(out.filtered_non_source).toBeUndefined();
  });

  it("json: --limit filters non-source orphans", async () => {
    fakeClient.runSmells.mockResolvedValue(report([cand("README.md", 0.9), cand("src/a.ts", 0.5)]));
    await run("--format", "json", "--limit", "10");
    const out = JSON.parse(logs.join("\n"));
    expect(out.count).toBe(1);
    expect(out.filtered_non_source).toBe(1);
  });

  it("json: --limit 5 cuts and keeps the total", async () => {
    await run("--format", "json", "--limit", "5");
    const out = JSON.parse(logs.join("\n"));
    expect(out.candidates.length).toBe(5);
    expect(out.count).toBe(80);
    expect(out.shown).toBe(5);
    expect(out.truncated).toBe(true);
  });

  it("--limit 0 shows everything", async () => {
    const lines = await run("--format", "llm", "--limit", "0");
    expect(lines[0]).toBe("smells rev=7 count=80 shown=80 version=smell_v1");
    expect(lines.some(l => l.startsWith("diagnostic"))).toBe(false);
  });

  it("--limit 0 keeps non-source orphans in every format", async () => {
    fakeClient.runSmells.mockResolvedValue(report([cand("README.md", 0.9), cand("src/a.ts", 0.5)]));
    await run("--format", "json", "--limit", "0");
    const out = JSON.parse(logs.join("\n"));
    expect(out.candidates.map((c: { file: string }) => c.file)).toEqual(["README.md", "src/a.ts"]);
    expect(out.filtered_non_source).toBeUndefined();

    logs.length = 0;
    const lines = await run("--format", "llm", "--limit", "0");
    expect(lines.some(l => l.includes("README.md"))).toBe(true);
    expect(lines.some(l => l.includes("filtered_non_source"))).toBe(false);
  });
});
