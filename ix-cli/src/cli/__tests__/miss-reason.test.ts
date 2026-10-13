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

  it("gives up (null) when the graph lookup fails, rather than guessing", async () => {
    const failing = { search: vi.fn(async (): Promise<any[]> => { throw new Error("backend down"); }) };
    expect(await explainSymbolMiss(failing, "renderGadget", {})).toBeNull();
  });
});
