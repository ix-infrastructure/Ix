// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeClient = {
  runSmells: vi.fn(),
  listSmells: vi.fn(),
  nodes: vi.fn(),
};

vi.mock("../../client/factory.js", () => ({ createClient: () => fakeClient }));
vi.mock("../resolve.js", () => ({ resolveReadSystemId: async () => undefined }));
vi.mock("../bootstrap.js", () => ({ resolveWorkspaceId: () => "ws-test" }));

import { registerSmellsCommand, withFilePaths, type SmellCandidate, type SmellReport } from "../commands/smells.js";

/**
 * The backend names a smell candidate's file by its basename. `--format json`
 * adds each file's `path`, read from its node, so a path filter (MCP
 * ix_smells) can match a directory.
 */

function cand(id: string, file: string, confidence: number): SmellCandidate {
  return { file_id: id, file, smell: "has_smell.weak_component_member", confidence, signals: { neighbor_count: 1 }, inference_version: "smell_v1" };
}

// Two files share the basename, as the backend reports them.
const REPORT: SmellReport = {
  rev: 7,
  run_at: "2026-10-11T00:00:00Z",
  count: 3,
  candidates: [cand("f1", "util.ts", 0.9), cand("f2", "util.ts", 0.8), cand("f3", "logger.ts", 0.7)],
};

/**
 * `POST /v1/nodes` rows as the backend answers them without `fields: "full"`:
 * a summary whose `path` is the node's provenance.sourceUri (Ix-memory
 * BatchReadRoutes.summary), not a whole GraphNode.
 */
function summary(id: string, name: string, path: string) {
  return { id, kind: "file", name, path, lineStart: null, lineEnd: null };
}

const NODES = [
  summary("f1", "util.ts", "app/util.ts"),
  summary("f2", "util.ts", "lib/util.ts"),
  summary("f3", "logger.ts", "lib/logger.ts"),
];

/** `POST /v1/nodes` as the backend answers it: the live nodes among the ids asked for. */
function nodesOf(all: typeof NODES) {
  return async (ids: string[]) => {
    const nodes = all.filter((n) => ids.includes(n.id));
    return { rev: 7, nodes, missing: ids.filter((id) => !nodes.some((n) => n.id === id)) };
  };
}

describe("ix smells --format json carries each file's path", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fakeClient.runSmells.mockReset().mockResolvedValue(REPORT);
    fakeClient.listSmells.mockReset();
    fakeClient.nodes.mockReset().mockImplementation(nodesOf(NODES));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerSmellsCommand(program);
    await program.parseAsync(["smells", ...args], { from: "user" });
    return logs.join("\n");
  }

  it("adds the workspace-relative path beside the basename, in one read", async () => {
    const out = JSON.parse(await run(["--format", "json"]));
    expect(fakeClient.nodes.mock.calls).toEqual([[["f1", "f2", "f3"]]]);
    expect(out.candidates.map((c: any) => [c.file, c.path])).toEqual([
      ["util.ts", "app/util.ts"], ["util.ts", "lib/util.ts"], ["logger.ts", "lib/logger.ts"],
    ]);
    expect(Object.keys(out.candidates[0])).toEqual(["file", "path", "smell", "confidence", "signals"]);
    expect(Object.keys(out)).toEqual(["rev", "run_at", "count", "shown", "truncated", "inference_version", "candidates"]);
  });

  it("reads the path from provenance.sourceUri when given a whole node", async () => {
    fakeClient.nodes.mockResolvedValue({
      nodes: [{ id: "f1", kind: "file", name: "util.ts", attrs: {}, provenance: { sourceUri: "app/util.ts" } }],
    });
    const out = JSON.parse(await run(["--format", "json"]));
    expect(out.candidates[0].path).toBe("app/util.ts");
  });

  it("shows an absolute stored path relative to the current directory when inside it", async () => {
    fakeClient.nodes.mockResolvedValue({
      nodes: [
        summary("f1", "util.ts", `${process.cwd()}/app/util.ts`),
        summary("f2", "util.ts", "/nowhere-ix-test/lib/util.ts"),
      ],
    });
    const out = JSON.parse(await run(["--format", "json"]));
    expect(out.candidates[0].path).toBe("app/util.ts");
    expect(out.candidates[1].path).toBe("/nowhere-ix-test/lib/util.ts");
  });

  it("a file that is no longer in the graph keeps only its basename", async () => {
    fakeClient.nodes.mockImplementation(nodesOf(NODES.slice(0, 2)));
    const out = JSON.parse(await run(["--format", "json"]));
    expect(out.candidates[2]).toEqual({
      file: "logger.ts", smell: "has_smell.weak_component_member", confidence: 0.7, signals: { neighbor_count: 1 },
    });
    expect(out.candidates[0].path).toBe("app/util.ts");
  });

  it("a backend without the batched node read answers as before, exit 0", async () => {
    fakeClient.nodes.mockRejectedValue(new Error("404 Not Found"));
    const out = JSON.parse(await run(["--format", "json"]));
    expect(out.count).toBe(3);
    expect(out.candidates.every((c: any) => !("path" in c))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("llm and text make no extra request and print the basename as before", async () => {
    const llm = await run(["--format", "llm"]);
    expect(llm.split("\n")[1]).toBe("smell kind=has_smell.weak_component_member file=util.ts confidence=0.9 neighbors=1");
    logs = [];
    await run([]);
    expect(fakeClient.nodes).not.toHaveBeenCalled();
  });

  it("a stale answer reads the paths by each claim's entity id", async () => {
    fakeClient.runSmells.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    fakeClient.listSmells.mockResolvedValue({
      smells: [
        { smell: "has_smell.weak_component_member", entity_id: "f2", value: { confidence: 0.8, file: "util.ts", signals: { neighbor_count: 1 } }, inference_version: "smell_v1" },
      ],
      total: 1,
      truncated: false,
    });
    const out = JSON.parse(await run(["--format", "json"]));
    expect(out.stale).toBe(true);
    expect(out.candidates).toEqual([{
      file: "util.ts", path: "lib/util.ts", smell: "has_smell.weak_component_member", confidence: 0.8,
      signals: { neighbor_count: 1 }, entity_id: "f2",
    }]);
  });
});

describe("withFilePaths", () => {
  it("asks for at most 1000 ids per read, each id once", async () => {
    const many = Array.from({ length: 2001 }, (_, i) => cand(`f${i}`, "a.ts", 0.5));
    const sizes: number[] = [];
    const client = {
      nodes: async (ids: string[]) => {
        sizes.push(ids.length);
        return { nodes: ids.map((id) => summary(id, "a.ts", `src/${id}/a.ts`)) };
      },
    };
    const out = await withFilePaths(client, [...many, many[0]]);
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(out[2000].path).toBe("src/f2000/a.ts");
    expect(out[2001].path).toBe("src/f0/a.ts");
  });

  it("a failed read leaves only that batch without paths", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => cand(`f${i}`, "a.ts", 0.5));
    let call = 0;
    const client = {
      nodes: async (ids: string[]) => {
        if (call++ === 0) throw new Error("boom");
        return { nodes: ids.map((id) => summary(id, "a.ts", `src/${id}/a.ts`)) };
      },
    };
    const out = await withFilePaths(client, many);
    expect(out[0].path).toBeUndefined();
    expect(out[1000].path).toBe("src/f1000/a.ts");
  });
});
