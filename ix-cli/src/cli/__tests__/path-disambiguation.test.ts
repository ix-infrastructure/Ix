import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerCallersCommand } from "../commands/callers.js";
import { registerImpactCommand } from "../commands/impact.js";
import { registerImportsCommand } from "../commands/imports.js";

const { search, expand } = vi.hoisted(() => ({ search: vi.fn(), expand: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
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
  bucketByHierarchy: async () => [],
}));

async function run(command: string, args: string[]) {
  const program = new Command().name("ix").exitOverride();
  registerCallersCommand(program);
  registerImpactCommand(program);
  registerImportsCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  await program.parseAsync([command, "Duplicate", ...args, "--format", "json"], { from: "user" });
  return JSON.parse(output.join("\n"));
}

describe.each(["impact", "callers", "callees", "imports", "imported-by"])("%s path disambiguation", (command) => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    search.mockReset().mockResolvedValue([
      { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
      { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
    ]);
    expand.mockReset().mockResolvedValue({
      nodes: command === "impact" ? [] : [{ id: "related-id", kind: "function", name: "Related" }],
      edges: [],
    });
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  it("selects only the candidate matching --path", async () => {
    const output = await run(command, ["--path", "second.ts"]);
    expect(process.exitCode).toBeUndefined();
    expect(output.resolvedTarget).toMatchObject({ name: "Duplicate", kind: "function" });
    expect(expand).toHaveBeenCalled();
    expect(expand.mock.calls.every(([id]) => id === "second-id")).toBe(true);
  });

  it("does not silently select a candidate outside --path", async () => {
    const output = await run(command, ["--path", "missing.ts"]);
    expect(process.exitCode).toBe(1);
    expect(output.error).toBe("unresolved_target");
    expect(expand).not.toHaveBeenCalled();
  });

  it("preserves ambiguity when no filter is supplied", async () => {
    const output = await run(command, []);
    expect(process.exitCode).toBe(1);
    expect(output.error).toBe("ambiguous_target");
    expect(expand).not.toHaveBeenCalled();
  });
});
