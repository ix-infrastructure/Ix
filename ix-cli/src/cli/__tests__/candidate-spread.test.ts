// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerLocateCommand } from "../commands/locate.js";
import { CONTAINER_LOOKUP_TIMEOUT_MS, resolveFileOrEntityFull, roundRobinByFile } from "../resolve.js";

// An ambiguous name lists 8 candidates. A file that defines the name many times
// must not fill that page on its own: the page is dealt round-robin by file
// (best of each file, then second-best, ...), and that order is the one
// `--pick` and `--all` number by. Each row names the type that contains it.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search, expand, expandByName } = vi.hoisted(() => ({
  search: vi.fn(), expand: vi.fn(), expandByName: vi.fn(),
}));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async expandByName(...args: unknown[]) { return expandByName(...args); }
    async resolvePrefix(p: string) { return p; }
    async entity(id: string) {
      return { node: { id, kind: "method", name: "crop", attrs: { line_start: 1, line_end: 2 }, provenance: { sourceUri: `src/${id}.py` } } };
    }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => false,
  explainSymbolMiss: async () => null,
}));

const CACHE = "src/transformers/cache_utils.py";
const MODEL = "src/transformers/a_model.py";
const GEN = "src/transformers/generation/utils.py";
const IMAGE = "src/transformers/image_utils.py";

const method = (id: string, path: string, line: number) => ({
  id, kind: "method", name: "crop", attrs: { line_start: line, line_end: line + 5 }, provenance: { sourceUri: path },
});

/** 12 `crop` methods: 8 in one file, 4 spread over three others. */
const CROPS = [
  ...Array.from({ length: 8 }, (_, i) => method(`cache-${i + 1}`, CACHE, (i + 1) * 100)),
  method("model-1", MODEL, 5),
  method("gen-1", GEN, 10),
  method("gen-2", GEN, 20),
  method("image-1", IMAGE, 1),
];

/** The page as a reader sees it: files in path order, each file's next best per round. */
const ROUND_ROBIN = ["model-1", "cache-1", "gen-1", "image-1", "cache-2", "gen-2", "cache-3", "cache-4"];
const REST = ["cache-5", "cache-6", "cache-7", "cache-8"];

/** The classes holding each crop: CONTAINS edges into it, as /v1/expand-by-name returns them. */
const OWNERS: Record<string, { id: string; kind: string; name: string }> = {
  "cache-1": { id: "cls-dynamic", kind: "class", name: "DynamicLayer" },
  "cache-2": { id: "cls-static", kind: "class", name: "StaticLayer" },
  "gen-1": { id: "cls-gen", kind: "class", name: "GenerationMixin" },
  // A top-level function: its only parent is the file, which is no container.
  "image-1": { id: "file-image", kind: "file", name: "image_utils.py" },
};

function containsGraph() {
  const nodes = Object.values(OWNERS).map((o) => ({ ...o, attrs: {}, provenance: { sourceUri: "x" } }));
  const edges = Object.entries(OWNERS).map(([dst, o]) => ({ id: `e-${dst}`, src: o.id, dst, predicate: "CONTAINS", attrs: {} }));
  return { nodes, edges };
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  registerLocateCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => { stderr.push(parts.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => {
    stderr.push(String(part).replace(/\n$/, ""));
    return true;
  }) as never);
  process.exitCode = undefined;
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode: Number(process.exitCode ?? 0) };
}

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  search.mockReset().mockImplementation(async (term: string) => (term === "crop" ? CROPS : []));
  expand.mockReset().mockImplementation(async () => ({ nodes: [], edges: [] }));
  expandByName.mockReset().mockImplementation(async () => containsGraph());
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("roundRobinByFile", () => {
  it("deals the best of each file first, then the second-best, keeping each file's order", () => {
    const n = (id: string, path: string) => ({ id, provenance: { sourceUri: path } });
    const ranked = [n("a1", "a.py"), n("a2", "a.py"), n("a3", "a.py"), n("b1", "b.py"), n("c1", "c.py"), n("b2", "b.py")];
    expect(roundRobinByFile(ranked).map((x) => x.id)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3"]);
  });

  it("groups Windows and posix spellings of one file together", () => {
    const n = (id: string, path: string) => ({ id, provenance: { sourceUri: path } });
    const ranked = [n("w1", "C:\\repo\\src\\a.py"), n("w2", "C:/repo/src/a.py"), n("b1", "C:\\repo\\src\\b.py")];
    expect(roundRobinByFile(ranked).map((x) => x.id)).toEqual(["w1", "b1", "w2"]);
  });

  it("keeps every candidate, once", () => {
    const n = (id: string, path: string) => ({ id, provenance: { sourceUri: path } });
    const ranked = [n("x", "a.py"), n("y", "a.py"), n("z", "b.py")];
    expect(roundRobinByFile(ranked).map((x) => x.id).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("ambiguous candidates spread across files", () => {
  it("the first page covers min(8, files) files, in round-robin order (json)", async () => {
    const result = await run(["locate", "crop", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body.total).toBe(12);
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(ROUND_ROBIN);
    expect(body.candidates.map((c: { rank: number }) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(body.candidates.map((c: { path: string }) => c.path)).size).toBe(4);
  });

  it("shows every candidate when there are 8 or fewer", async () => {
    search.mockImplementation(async (term: string) => (term === "crop" ? CROPS.slice(5, 11) : []));
    const body = JSON.parse((await run(["locate", "crop", "--format", "json"])).stdout);
    // cache-6..8, model-1, gen-1, gen-2
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["model-1", "cache-6", "gen-1", "cache-7", "gen-2", "cache-8"]);
    expect(body.total).toBe(6);
  });

  it("--pick n resolves to the candidate shown as n, past the first page too", async () => {
    const shown = JSON.parse((await run(["locate", "crop", "--format", "json"])).stdout).candidates;
    for (const c of shown) {
      const picked = JSON.parse((await run(["locate", "crop", "--pick", String(c.rank), "--format", "json"])).stdout);
      expect(picked.resolvedTarget.id).toBe(c.id);
    }
    const ninth = JSON.parse((await run(["locate", "crop", "--pick", "9", "--format", "json"])).stdout);
    expect(ninth.resolvedTarget.id).toBe(REST[0]);
  });

  it("--all numbers its candidate=<n> rows by the same order", async () => {
    expand.mockImplementation(async (id: string) => ({
      nodes: [{ id: `caller-of-${id}`, kind: "function", name: `callerOf_${id}`, provenance: { sourceUri: "src/use.py" } }],
      edges: [],
    }));
    const body = JSON.parse((await run(["callers", "crop", "--all", "--limit", "100", "--format", "json"])).stdout);
    expect(body.candidates.map((c: { n: number; id: string }) => `${c.n}:${c.id}`))
      .toEqual([...ROUND_ROBIN, ...REST].map((id, i) => `${i + 1}:${id}`));
    for (const row of body.results) {
      expect(row.name).toBe(`callerOf_${[...ROUND_ROBIN, ...REST][row.candidate - 1]}`);
    }
    // --all lists no containers, so it asks for none.
    expect(expandByName).not.toHaveBeenCalled();
  });

  it("deals only among equal scores: an import never goes ahead of a definition", async () => {
    // Two definitions in one file and an import of the name in each of nine
    // other files. The imports score worse (+5) but inside the window; dealt
    // across the whole list they would push the second definition off the page.
    const def = (id: string, line: number) => ({
      id, kind: "function", name: "clamp", attrs: { line_start: line, line_end: line + 3 }, provenance: { sourceUri: "app/utils.py" },
    });
    const imports = Array.from({ length: 9 }, (_, i) => ({
      id: `import-${i}`, kind: "module", name: "clamp", attrs: { line_start: 1, line_end: 1 }, provenance: { sourceUri: `app/use${i}.py` },
    }));
    search.mockImplementation(async (term: string) => (term === "clamp" ? [...imports, def("def-1", 10), def("def-2", 40)] : []));
    const body = JSON.parse((await run(["locate", "clamp", "--format", "json"])).stdout);
    expect(body.total).toBe(11);
    expect(body.candidates.map((c: { id: string }) => c.id))
      .toEqual(["def-1", "def-2", ...imports.slice(0, 6).map((i) => i.id)]);
  });
});

describe("candidate rows name their container", () => {
  it("json: an additive `container` key, only where there is one", async () => {
    const body = JSON.parse((await run(["locate", "crop", "--format", "json"])).stdout);
    const byId = Object.fromEntries(body.candidates.map((c: { id: string }) => [c.id, c]));
    expect(byId["cache-1"].container).toBe("DynamicLayer");
    expect(byId["cache-2"].container).toBe("StaticLayer");
    expect(byId["gen-1"].container).toBe("GenerationMixin");
    // The file is not a container; no CONTAINS parent at all is none either.
    expect(byId["image-1"]).not.toHaveProperty("container");
    expect(byId["model-1"]).not.toHaveProperty("container");
    // The existing keys, unchanged.
    expect(Object.keys(byId["model-1"])).toEqual(["id", "name", "kind", "path", "line", "score", "rank"]);
    expect(Object.keys(byId["cache-1"])).toEqual(["id", "name", "kind", "path", "line", "score", "rank", "container"]);
    // One request for the name, not one per candidate.
    expect(expandByName).toHaveBeenCalledTimes(1);
    expect(expandByName).toHaveBeenCalledWith("crop", { direction: "in", predicates: ["CONTAINS"], timeoutMs: CONTAINER_LOOKUP_TIMEOUT_MS });
  });

  it("llm: `container=` ends the candidate record", async () => {
    const lines = (await run(["locate", "crop", "--format", "llm"])).stdout.split("\n");
    const candidates = lines.filter((l) => l.startsWith("candidate "));
    expect(candidates[1]).toMatch(/^candidate n=2 name=crop kind=method path=src\/transformers\/cache_utils\.py id=cache-1 container=DynamicLayer$/);
    expect(candidates[0]).toMatch(/^candidate n=1 name=crop kind=method path=src\/transformers\/a_model\.py id=model-1$/);
  });

  it("text: the container beside the name, and the line", async () => {
    const result = await run(["locate", "crop"]);
    expect(result.stderr).toMatch(/2\. method\s+cache-1\s+crop {2}DynamicLayer in src\/transformers\/cache_utils\.py:100/);
    expect(result.stderr).toMatch(/1\. method\s+model-1\s+crop in src\/transformers\/a_model\.py:5/);
  });

  it("a backend that cannot answer leaves the containers out and the ambiguity as it was", async () => {
    expandByName.mockRejectedValue(new Error("500: boom"));
    const result = await run(["locate", "crop", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(ROUND_ROBIN);
    expect(body.candidates.some((c: object) => "container" in c)).toBe(false);
  });

  it("locate asks once for a dotted name it re-reads as Class.method", async () => {
    // `Config.load` matches only fuzzily, in two files (ambiguous), and no
    // class Config exists: locate tries the qualified reading, keeps the
    // literal ambiguity, and asks for containers on that result only.
    const entry = (id: string, path: string) => ({
      id, kind: "config_entry", name: "Config.loadAll", attrs: { line_start: 3, line_end: 3 }, provenance: { sourceUri: path },
    });
    search.mockImplementation(async () => [entry("e1", "conf/a.toml"), entry("e2", "conf/b.toml")]);
    const result = await run(["locate", "Config.load", "--format", "json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).candidates.map((c: { id: string }) => c.id).sort()).toEqual(["e1", "e2"]);
    expect(expandByName).toHaveBeenCalledTimes(1);
  });

  it("--pick resolves without asking for containers", async () => {
    await run(["locate", "crop", "--pick", "2", "--format", "json"]);
    expect(expandByName).not.toHaveBeenCalled();
  });
});

describe("a file name shared by several files", () => {
  // Every candidate is its own file, so the order is the match ranking (the
  // shortest path first): the file the notice says it used is number 1.
  const files = ["a/very/deep/dir/index.ts", "b/index.ts", "c/src/index.ts"].map((p) => ({
    id: p, name: "index.ts", kind: "file", attrs: {}, provenance: { sourceUri: p },
  }));
  const fileClient = () => ({
    search: vi.fn(async (term: string) => files.filter((f) => f.name.includes(term.split("/").pop()!))),
    workspaceSystem: vi.fn(async () => null),
    expandByName,
  }) as any;

  it("numbers the tie in rank order, chosen first, and --pick follows it", async () => {
    const r = await resolveFileOrEntityFull(fileClient(), "index.ts", { format: "json" } as any);
    expect(r.resolved && r.entity.path).toBe("b/index.ts");
    const notice = r.resolved ? r.notices?.find((n) => n.code === "ambiguous_target") : undefined;
    expect(notice?.candidates.map((c) => c.path)).toEqual(["b/index.ts", "c/src/index.ts", "a/very/deep/dir/index.ts"]);
    const picked = await resolveFileOrEntityFull(fileClient(), "index.ts", { format: "json", pick: 3 } as any);
    expect(picked.resolved && picked.entity.path).toBe("a/very/deep/dir/index.ts");
    // A tie that resolves asks for no containers.
    expect(expandByName).not.toHaveBeenCalled();
  });
});
