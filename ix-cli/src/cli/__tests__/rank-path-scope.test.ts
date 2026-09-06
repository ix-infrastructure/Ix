import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerRankCommand } from "../commands/rank.js";

const { listByKind, expand } = vi.hoisted(() => ({ listByKind: vi.fn(), expand: vi.fn() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async listByKind(...args: unknown[]) { return listByKind(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
  },
}));
vi.mock("../resolve.js", () => ({
  ensureReadScope: async () => {},
  activeReadScope: () => ({ workspaceId: "test-workspace" }),
}));

async function run(args: string[]) {
  const program = new Command().name("ix").exitOverride();
  registerRankCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
  await program.parseAsync(["rank", "--by", "members", "--kind", "class", "--format", "json", ...args], { from: "user" });
  return JSON.parse(output.join("\n"));
}

describe("rank path filtering before the candidate limit", () => {
  beforeEach(() => {
    const nodes = [
      ...Array.from({ length: 2000 }, (_, i) => ({ id: `other-${i}`, name: `Other${i}`, kind: "class", provenance: { sourceUri: "src/other.ts" } })),
      { id: "wanted", name: "Wanted", kind: "class", provenance: { sourceUri: "src/target.ts" } },
    ];
    listByKind.mockReset().mockImplementation(async (_kind, opts) =>
      nodes.filter(n => !opts.scope || n.provenance.sourceUri.includes(opts.scope)).slice(0, opts.limit),
    );
    expand.mockReset().mockResolvedValue({ nodes: [{ id: "member" }], edges: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("ranks a matching entity beyond the first 2000 unfiltered candidates", async () => {
    const output = await run(["--path", "src/target.ts"]);
    expect(listByKind).toHaveBeenCalledWith("class", { limit: 2000, scope: "src/target.ts", workspaceId: "test-workspace" });
    expect(output.results).toEqual([{ name: "Wanted", kind: "class", score: 1 }]);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("wanted", expect.anything());
  });

  it("preserves client-side exclusions after the scoped fetch", async () => {
    const output = await run(["--path", "src/target.ts", "--exclude-path", "target"]);
    expect(output.results).toEqual([]);
    expect(expand).not.toHaveBeenCalled();
  });

  it("reports a genuinely unmatched path without expanding unrelated entities", async () => {
    const output = await run(["--path", "missing.ts"]);
    expect(output.results).toEqual([]);
    expect(expand).not.toHaveBeenCalled();
  });
});
