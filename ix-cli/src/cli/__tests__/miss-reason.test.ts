// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({ root: "" }));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  resolveWorkspaceRoot: () => workspace.root,
}));

const { explainSymbolMiss, MISS_PROBE_ENV } = await import("../miss-reason.js");
const { runWithSignal } = await import("../../client/run-signal.js");
const { withMissReason } = await import("../resolve.js");

const hasRipgrep = (() => {
  try { execFileSync("rg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

/** A client whose graph holds exactly these files. */
function client(indexed: Array<{ uri: string; rev?: number }>) {
  return {
    search: vi.fn(async (term: string): Promise<any[]> => indexed
      .filter((f) => f.uri.split("/").pop() === term)
      .map((f) => ({ id: `id-${f.uri}`, kind: "file", name: term, createdRev: f.rev, provenance: { sourceUri: f.uri } }))),
  };
}

describe.skipIf(!hasRipgrep)("explainSymbolMiss", () => {
  let savedHome: string | undefined;

  beforeAll(() => {
    workspace.root = mkdtempSync(join(tmpdir(), "ix-miss-reason-"));
    mkdirSync(join(workspace.root, "src"));
    writeFileSync(join(workspace.root, "src", "indexed.ts"), "export const x = 1;\nfunction helper() { return parseWidget; }\n");
    writeFileSync(join(workspace.root, "src", "skipped.go"), "package main\nfunc renderGadget() {}\n");
    // Sorted ahead of src/: an unindexed source file, and a file Ix never parses.
    mkdirSync(join(workspace.root, "aaa"));
    writeFileSync(join(workspace.root, "aaa", "early.go"), "package aaa\n// see frobnicate\n");
    writeFileSync(join(workspace.root, "aaa", "notes.txt"), "frobnicate and onlyInProse\n");
    writeFileSync(join(workspace.root, "src", "late.ts"), "const s = \"frobnicate\";\n");
    // A dot-directory `ix map` parses, and one it skips (file-discovery.ts SKIPPED_DIRS).
    mkdirSync(join(workspace.root, ".storybook"));
    writeFileSync(join(workspace.root, ".storybook", "preview.ts"), "export const storybookOnlyName = 1;\n");
    mkdirSync(join(workspace.root, ".venv", "lib"), { recursive: true });
    writeFileSync(join(workspace.root, ".venv", "lib", "site.py"), "venvOnlyName = 1\n");
  });

  afterAll(() => {
    rmSync(workspace.root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env[MISS_PROBE_ENV] = "1";
    savedHome = process.env.IX_HOME;
    process.env.IX_HOME = join(workspace.root, ".ix-home");
  });

  afterEach(() => {
    process.env[MISS_PROBE_ENV] = "0";
    if (savedHome === undefined) delete process.env.IX_HOME;
    else process.env.IX_HOME = savedHome;
  });

  it("names a file the graph never indexed", async () => {
    const why = await explainSymbolMiss(client([{ uri: "src/indexed.ts", rev: 7 }]), "renderGadget", {});
    expect(why).toMatchObject({ reason: "symbol_file_not_indexed", files: ["src/skipped.go"] });
    expect(why?.message).toContain("src/skipped.go, which has not been indexed");
  });

  it("names the indexed file and its revision when the name was not extracted", async () => {
    const why = await explainSymbolMiss(client([{ uri: "src/indexed.ts", rev: 7 }]), "parseWidget", {});
    expect(why).toMatchObject({ reason: "symbol_not_extracted", files: ["src/indexed.ts"] });
    expect(why?.message).toContain("src/indexed.ts (indexed at rev 7)");
  });

  it("matches an absolute source uri by its workspace-relative suffix", async () => {
    const why = await explainSymbolMiss(client([{ uri: `${workspace.root}/src/indexed.ts` }]), "parseWidget", {});
    expect(why?.reason).toBe("symbol_not_extracted");
  });

  it("says when the name is nowhere in the workspace either", async () => {
    const why = await explainSymbolMiss(client([]), "NoSuchNameAnywhere", {});
    expect(why).toMatchObject({ reason: "symbol_not_in_source" });
  });

  it("reads the last segment of a qualified name, and honours --path", async () => {
    expect((await explainSymbolMiss(client([]), "Widget.renderGadget", {}))?.reason).toBe("symbol_file_not_indexed");
    expect((await explainSymbolMiss(client([]), "renderGadget", { path: "lib/" }))?.reason).toBe("symbol_not_in_source");
  });

  it("searches the dot-directories ix map parses, not the ones it skips", async () => {
    const why = await explainSymbolMiss(client([]), "storybookOnlyName", {});
    expect(why).toMatchObject({ reason: "symbol_file_not_indexed", files: [".storybook/preview.ts"] });
    expect((await explainSymbolMiss(client([]), "venvOnlyName", {}))?.reason).toBe("symbol_not_in_source");
  });

  it("is skipped by IX_MISS_PROBE=0, and for a target that is not a name", async () => {
    expect(await explainSymbolMiss(client([]), "a b", {})).toBeNull();
    process.env[MISS_PROBE_ENV] = "0";
    expect(await explainSymbolMiss(client([]), "renderGadget", {})).toBeNull();
  });

  it("asks for the file by path (scope), so same-named files elsewhere cannot crowd it out", async () => {
    const c = client([{ uri: "src/indexed.ts", rev: 7 }]);
    await explainSymbolMiss(c, "parseWidget", {});
    expect(c.search).toHaveBeenCalledWith("indexed.ts", expect.objectContaining({ scope: "src/indexed.ts", kind: "file" }));
  });

  it("does not claim a file was never indexed when a full window (an older backend ignoring scope) lacks it", async () => {
    // 51 same-named files, the indexed one last: a backend without `scope`
    // returns the first 50 and the target is not among them.
    const crowd = Array.from({ length: 51 }, (_, i) => ({ uri: i === 50 ? "src/skipped.go" : `vendor/p${i}/skipped.go` }));
    const all = client(crowd);
    const windowed = { search: vi.fn(async (term: string, opts?: { limit?: number }) => (await all.search(term)).slice(0, opts?.limit)) };
    expect(await explainSymbolMiss(windowed, "renderGadget", {})).toBeNull();
  });

  it("does not send an agent to `ix map` when an indexed file has the name and an earlier one is unindexed", async () => {
    const why = await explainSymbolMiss(client([{ uri: "src/late.ts", rev: 3 }]), "frobnicate", {});
    expect(why).toMatchObject({ reason: "symbol_not_extracted", files: ["aaa/early.go", "src/late.ts"] });
    expect(why?.message).toContain("src/late.ts (indexed at rev 3)");
  });

  it("ignores files Ix does not parse: the name only there is a plain miss", async () => {
    expect(await explainSymbolMiss(client([]), "onlyInProse", {})).toBeNull();
  });

  it("stops probing once a run has spent its time budget, per run", async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // Each graph lookup "takes" 6 s: one probe spends the whole budget.
      const slow = client([{ uri: "src/indexed.ts", rev: 7 }]);
      const base = slow.search.getMockImplementation()!;
      slow.search.mockImplementation(async (term: string) => { clock += 6_000; return base(term); });
      const spent = new AbortController().signal;
      await runWithSignal(spent, async () => {
        expect((await explainSymbolMiss(slow, "parseWidget", {}))?.reason).toBe("symbol_not_extracted");
        expect(await explainSymbolMiss(slow, "parseWidget", {})).toBeNull();
      });
      // Another run (another `ix mcp` call) has its own budget.
      await runWithSignal(new AbortController().signal, async () => {
        expect((await explainSymbolMiss(slow, "parseWidget", {}))?.reason).toBe("symbol_not_extracted");
      });
    } finally {
      now.mockRestore();
    }
  });

  it("gives up (null) when the graph lookup fails, rather than guessing", async () => {
    const failing = { search: vi.fn(async (): Promise<any[]> => { throw new Error("backend down"); }) };
    expect(await explainSymbolMiss(failing, "renderGadget", {})).toBeNull();
  });

  describe("withMissReason under --kind, --path or the test filter", () => {
    /** The graph has src/indexed.ts and, when `entity` is set, a function named parseWidget. */
    function graphWith(entity: boolean) {
      return {
        search: vi.fn(async (term: string, opts?: { kind?: string }): Promise<any[]> => {
          if (opts?.kind === "file") {
            return term === "indexed.ts" ? [{ id: "id-file", kind: "file", name: term, provenance: { sourceUri: "src/indexed.ts" } }] : [];
          }
          return entity && term === "parseWidget"
            ? [{ id: "id-fn", kind: "function", name: "parseWidget", provenance: { sourceUri: "src/indexed.ts" } }]
            : [];
        }),
      };
    }
    type Miss = { resolved: false; ambiguous: false; reason?: string; hiddenTestCount?: number };
    const miss = (extra: Partial<Miss> = {}): Miss => ({ resolved: false, ambiguous: false, ...extra });
    const inRun = <T>(fn: () => Promise<T>) => runWithSignal(new AbortController().signal, fn);

    it("does not call a name never extracted when a filter set its entity aside", async () => {
      await inRun(async () => {
        const graph = graphWith(true);
        const cases: Array<[Record<string, unknown>, Miss]> = [
          [{ kind: "class" }, miss()],
          [{ path: "src/" }, miss()],
          [{ testsOnly: true }, miss()],
          [{}, miss({ hiddenTestCount: 1 })],
        ];
        for (const [opts, result] of cases) {
          const out = await withMissReason(graph as any, "parseWidget", result, opts, "json");
          expect(out).toEqual(result);
        }
      });
    });

    it("still explains a filtered miss when no entity carries the name", async () => {
      await inRun(async () => {
        const out = await withMissReason(graphWith(false) as any, "parseWidget", miss(), { kind: "class" }, "json");
        expect(out).toMatchObject({ reason: "symbol_not_extracted" });
      });
    });

    it("spends no search on the filter check when the probe would not run", async () => {
      await inRun(async () => {
        const graph = graphWith(true);
        process.env[MISS_PROBE_ENV] = "0";
        expect(await withMissReason(graph as any, "parseWidget", miss(), { kind: "class" }, "json")).toEqual(miss());
        process.env[MISS_PROBE_ENV] = "1";
        expect(await withMissReason(graph as any, "not a name", miss(), { kind: "class" }, "json")).toEqual(miss());
        expect(graph.search).not.toHaveBeenCalled();
      });
    });

    it("spends no search on the filter check once the run's budget is spent", async () => {
      let clock = 1_000_000;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      try {
        await inRun(async () => {
          const slow = graphWith(false);
          const base = slow.search.getMockImplementation()!;
          slow.search.mockImplementation(async (...args: Parameters<typeof base>) => { clock += 6_000; return base(...args); });
          // No filter: straight to the probe, whose lookup spends the budget.
          expect(await withMissReason(slow as any, "parseWidget", miss(), {}, "json")).toMatchObject({ reason: "symbol_not_extracted" });
          slow.search.mockClear();
          expect(await withMissReason(slow as any, "parseWidget", miss(), { kind: "class" }, "json")).toEqual(miss());
          expect(slow.search).not.toHaveBeenCalled();
        });
      } finally {
        now.mockRestore();
      }
    });

    it("skips the probe when the unfiltered lookup fails", async () => {
      await inRun(async () => {
        const failing = { search: vi.fn(async (): Promise<any[]> => { throw new Error("backend down"); }) };
        expect(await withMissReason(failing as any, "parseWidget", miss(), { kind: "class" }, "json")).toEqual(miss());
      });
    });
  });
});
