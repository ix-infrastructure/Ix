// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const listByKind = vi.hoisted(() => vi.fn());
vi.mock("../../client/factory.js", () => ({ createClient: () => ({ listByKind }) }));
vi.mock("../resolve.js", () => ({ resolveReadSystemId: async () => undefined }));
vi.mock("../bootstrap.js", () => ({ resolveWorkspaceId: () => "ws" }));

import { registerInventoryCommand } from "../commands/inventory.js";
import { applyPathFilters } from "../commands/rank.js";
import { normalizeForPathMatch, normalizePathSeparators } from "../path-match.js";

/**
 * Ix#636: `--path` accepted only POSIX separators in `rank` and `inventory`,
 * while every stored source_uri is POSIX by construction
 * (`ingest.ts` → `toWorkspaceRelative` → `rel.split(nodePath.sep).join('/')`).
 * So on Windows the natural `--path src\cli` matched nothing at all, silently.
 *
 * The same issue settled case: `--path` is case-insensitive everywhere, so
 * rank/inventory compare with `normalizeForPathMatch`, the resolver's rule.
 * `normalizePathSeparators` itself still leaves case alone: it is what gets
 * sent to the backend, which lowercases for itself.
 */
const node = (sourceUri: string) => ({ provenance: { sourceUri } });

describe("normalizePathSeparators", () => {
  it("converts Windows separators and leaves POSIX alone", () => {
    expect(normalizePathSeparators("src\\cli\\rank.ts")).toBe("src/cli/rank.ts");
    expect(normalizePathSeparators("src/cli/rank.ts")).toBe("src/cli/rank.ts");
  });

  it("does not touch case", () => {
    expect(normalizePathSeparators("IX-Memory\\Src")).toBe("IX-Memory/Src");
  });

  it("treats null and undefined as empty", () => {
    expect(normalizePathSeparators(undefined)).toBe("");
    expect(normalizePathSeparators(null)).toBe("");
  });
});

describe("normalizeForPathMatch", () => {
  it("normalizes separators and lowercases", () => {
    expect(normalizeForPathMatch("IX-Memory\\Src")).toBe("ix-memory/src");
  });

  it("treats null and undefined as empty", () => {
    expect(normalizeForPathMatch(undefined)).toBe("");
    expect(normalizeForPathMatch(null)).toBe("");
  });
});

describe("rank --path separator handling", () => {
  const nodes = [node("ix-cli/src/cli/commands/rank.ts"), node("ix-cli/src/api/client.ts")];

  it("matches a Windows-style --path against POSIX source_uris", () => {
    // The regression: this returned [] before the fix.
    expect(applyPathFilters(nodes, "src\\cli")).toHaveLength(1);
    expect(applyPathFilters(nodes, "src\\cli")[0].provenance.sourceUri)
      .toBe("ix-cli/src/cli/commands/rank.ts");
  });

  it("still matches a POSIX --path exactly as before", () => {
    expect(applyPathFilters(nodes, "src/cli")).toHaveLength(1);
  });

  it("applies the same normalization to --exclude-path", () => {
    expect(applyPathFilters(nodes, undefined, "src\\cli")).toHaveLength(1);
    expect(applyPathFilters(nodes, undefined, "src\\cli")[0].provenance.sourceUri)
      .toBe("ix-cli/src/api/client.ts");
  });

  it("normalizes a backslash-bearing source_uri too", () => {
    // Defensive: github/transform.ts builds its own source_uris, and graphs
    // ingested before toWorkspaceRelative normalized separators can hold them.
    expect(applyPathFilters([node("legacy\\src\\cli\\old.ts")], "src/cli")).toHaveLength(1);
  });

  it("matches case-insensitively, like the resolver (#636)", () => {
    expect(applyPathFilters([node("IX-Memory/src/a.ts")], "ix-memory")).toHaveLength(1);
    expect(applyPathFilters([node("IX-Memory/src/a.ts")], "IX-Memory")).toHaveLength(1);
    expect(applyPathFilters([node("ix-memory/src/a.ts")], "IX-MEMORY\\SRC")).toHaveLength(1);
    expect(applyPathFilters([node("IX-Memory/src/a.ts")], undefined, "ix-memory")).toHaveLength(0);
  });
});

describe("inventory --path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listByKind.mockReset();
  });

  async function run(path: string): Promise<any> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInventoryCommand(program);
    await program.parseAsync(["inventory", "--kind", "class", "--path", path, "--format", "json"], { from: "user" });
    return JSON.parse(String(log.mock.calls[0][0]));
  }

  it("sends separators normalized and case as typed, and filters case-insensitively", async () => {
    // A current backend lowercases the scope itself; an older one matches it
    // case-sensitively, so the CLI must not lowercase what it sends.
    listByKind.mockResolvedValue([
      { name: "A", kind: "class", provenance: { source_uri: "IX-Memory/src/A.scala" } },
      { name: "B", kind: "class", provenance: { source_uri: "lib/B.scala" } },
    ]);
    const json = await run("ix-memory\\SRC");
    expect(listByKind).toHaveBeenCalledWith("class", expect.objectContaining({ scope: "ix-memory/SRC" }));
    expect(json.byFile).toEqual([{ path: "IX-Memory/src/A.scala", items: ["A"] }]);
  });
});
