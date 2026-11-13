// Copyright 2026 Ix Infrastructure Inc.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IxClient } from "../../client/api.js";
import type { GraphNode } from "../../client/types.js";
import {
  buildBundle,
  clampBudgets,
  registerContextCommand,
  saveInvestigation,
} from "../commands/context.js";
import type { ContextFacts } from "../explain/facts.js";
import { extractCandidates, pickStartingPoints, readIssueText } from "../explain/issue.js";
import { findFileNode } from "../file-node.js";

/**
 * `ix context --from-issue` against the inputs real issues arrive as: a
 * permalink to the file, a stack trace's absolute paths, a file PowerShell
 * wrote, a monorepo with many files of one name, and a saved bundle someone
 * later asks to `--diff`.
 */

describe("paths an issue names by URL or absolute path", () => {
  const files = ["src/utils/parse.py", "ix-cli/src/cli/commands/context.ts", "main.go"];
  const none = async () => [];

  it("resolves a repository permalink and a stack trace frame to the tracked file", async () => {
    const text = [
      "See https://github.com/ix-infrastructure/Ix/blob/main/ix-cli/src/cli/commands/context.ts#L120.",
      "Traceback (most recent call last):",
      '  File "/home/me/work/proj/src/utils/parse.py", line 12, in parse',
      "    at run (/srv/app/main.go:4:2)",
    ].join("\n");
    const { starts, unresolved } = await pickStartingPoints(text, { files, search: none });
    expect(starts.map((s) => [s.path, s.via])).toEqual([
      ["ix-cli/src/cli/commands/context.ts", "path in issue"],
      ["src/utils/parse.py", "path in issue"],
      ["main.go", "path in issue"],
    ]);
    expect(unresolved).toEqual([]);
  });

  it("leaves a path outside the repository unresolved", async () => {
    const { starts, unresolved } = await pickStartingPoints(
      'File "/usr/lib/python3.11/site-packages/requests/api.py", line 59', { files, search: none });
    expect(starts).toEqual([]);
    expect(unresolved).toEqual(["/usr/lib/python3.11/site-packages/requests/api.py"]);
  });

  it("scans a long unbroken run of path characters in linear time", () => {
    // Before the lookbehind refused `.` and `-`, every `.` in a run was a new
    // start and the scan was quadratic: 40 KB of `a.` took over four seconds.
    const runs = ["a.".repeat(100_000), "x-".repeat(100_000), Array.from({ length: 5000 }, (_, i) => `f${i}`).join("-")];
    const started = performance.now();
    for (const run of runs) expect(extractCandidates(`${run} src/a.ts`).paths).toEqual(["src/a.ts"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("readIssueText encodings", () => {
  const text = "The `listByKind` call is slow\n";
  const bytes = (buf: Buffer) => Readable.from([buf]);

  it("reads UTF-16LE with a BOM, as Windows PowerShell 5.1 writes a redirect", async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(await readIssueText("-", bytes(le))).toBe(text);
  });

  it("reads UTF-16BE with a BOM", async () => {
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    expect(await readIssueText("-", bytes(be))).toBe(text);
  });

  it("drops a UTF-8 BOM", async () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    expect(await readIssueText("-", bytes(utf8))).toBe(text);
  });
});

describe("findFileNode among many files of one name", () => {
  const namesakes = Array.from({ length: 30 }, (_, i) => `pkg${String(i + 1).padStart(2, "0")}/index.ts`);
  const node = (path: string) => ({ id: `node:${path}`, kind: "file", name: "index.ts", provenance: { sourceUri: path } });

  function client(appliesScope: boolean) {
    const search = vi.fn(async (_term: string, opts?: { limit?: number; scope?: string }) => {
      const pool = appliesScope && opts?.scope ? namesakes.filter((p) => p.includes(opts.scope!)) : namesakes;
      // The backend's order is not the path's: pkg25 comes back near the end.
      return [...pool].reverse().slice(0, opts?.limit ?? 50).map(node) as unknown as GraphNode[];
    });
    return { search, client: { search } as unknown as IxClient };
  }

  it("finds the file on a backend that ignores scope, past the first ten namesakes", async () => {
    const { client: c } = client(false);
    expect((await findFileNode(c, "pkg05/index.ts", { scope: {} }))?.id).toBe("node:pkg05/index.ts");
  });

  it("narrows the search to the path on a backend that applies scope", async () => {
    const { client: c, search } = client(true);
    expect((await findFileNode(c, "pkg25/index.ts", { scope: {} }))?.id).toBe("node:pkg25/index.ts");
    expect(search.mock.calls[0]?.[1]).toMatchObject({ kind: "file", scope: "pkg25/index.ts" });
  });
});

describe("--diff of an investigation built from an issue", () => {
  let home: string;
  let stderr: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ix-issue-diff-"));
    process.env.IX_HOME = home;
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.map(String).join(" ")));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IX_HOME;
    process.exitCode = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses instead of reporting the issue's rows as removed", async () => {
    const bundle = buildBundle({
      resolved: { id: "s-list", name: "listByKind", kind: "method", resolutionMode: "issue" },
      facts: {
        id: "s-list", name: "listByKind", kind: "method", path: "src/client/api.ts", members: [], memberRefs: [], memberCount: 0,
        callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
        topCallers: [], topDependents: [], historyLength: 1, stale: false, diagnostics: [],
      } as unknown as ContextFacts,
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: clampBudgets({}),
      graphCompleted: true,
      issue: {
        startingPoints: [{ token: "listByKind", id: "s-list", name: "listByKind", kind: "method", path: "src/client/api.ts", via: "identifier in issue" }],
        unresolved: [],
        fallback: false,
        rankedFiles: [{ path: "src/client/api.ts", score: 1, reason: "starting point" }],
      },
    });
    saveInvestigation("from-issue", bundle);

    const program = new Command().name("ix").exitOverride();
    registerContextCommand(program);
    await program.parseAsync(["context", "--diff", "from-issue"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("was built with --from-issue");
  });
});
