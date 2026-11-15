// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { IxClient } from "../../client/api.js";
import { fileUri, findFileNode } from "../file-node.js";
import { resolveCallList } from "../explain/facts.js";

const fileNode = (id: string, uri: string, spelling: "sourceUri" | "source_uri" = "sourceUri", kind = "file") => ({
  id, kind, name: uri.split("/").pop(), provenance: { [spelling]: uri },
});

function searchClient(rows: unknown[]) {
  const search = vi.fn(async (_term: string, _opts?: Record<string, unknown>) => rows);
  return { search, client: { search } as unknown as Pick<IxClient, "search"> };
}

const SCOPE = { workspaceId: "ws-1", systemId: undefined };

describe("findFileNode: the one file-node lookup", () => {
  it("returns the node whose path equals the workspace-relative path", async () => {
    const { client, search } = searchClient([
      fileNode("other", "pkg/src/lib.ts"), fileNode("want", "src/lib.ts"),
    ]);
    expect((await findFileNode(client, "src/lib.ts", { scope: SCOPE }))?.id).toBe("want");
    expect(search).toHaveBeenCalledWith("lib.ts", {
      kind: "file", nameOnly: true, limit: 200, scope: "src/lib.ts", workspaceId: "ws-1", systemId: undefined,
    });
  });

  it("reads the snake_case provenance spelling too", async () => {
    const { client } = searchClient([fileNode("snake", "src/lib.ts", "source_uri")]);
    expect((await findFileNode(client, "src/lib.ts", { scope: SCOPE }))?.id).toBe("snake");
  });

  it("normalises backslashes and a leading ./ in the asked-for path", async () => {
    const { client } = searchClient([fileNode("want", "src/lib.ts")]);
    expect((await findFileNode(client, ".\\src\\lib.ts", { scope: SCOPE }))?.id).toBe("want");
  });

  it("ignores rows that are not file nodes", async () => {
    const { client } = searchClient([fileNode("mod", "src/lib.ts", "sourceUri", "module")]);
    expect(await findFileNode(client, "src/lib.ts", { scope: SCOPE })).toBeUndefined();
  });

  it("by default matches the exact path only: a namesake elsewhere is not the file", async () => {
    // `ix context` pairs the node id with the path it asked for, so a git path
    // the graph does not hold must not borrow another directory's file node.
    const { client } = searchClient([fileNode("elsewhere", "packages/a/src/index.ts")]);
    expect(await findFileNode(client, "src/index.ts", { scope: SCOPE })).toBeUndefined();
  });

  it("with suffixMatch, accepts one path that ends in the asked-for path", async () => {
    const { client } = searchClient([fileNode("only", "packages/a/src/index.ts")]);
    expect((await findFileNode(client, "src/index.ts", { scope: SCOPE, suffixMatch: true }))?.id).toBe("only");
  });

  it("with suffixMatch, refuses to guess between two suffix matches", async () => {
    const { client } = searchClient([
      fileNode("a", "packages/a/src/index.ts"), fileNode("b", "packages/b/src/index.ts"),
    ]);
    expect(await findFileNode(client, "src/index.ts", { scope: SCOPE, suffixMatch: true })).toBeUndefined();
  });

  it("with suffixMatch, still prefers the exact path over a suffix match", async () => {
    const { client } = searchClient([
      fileNode("suffix", "packages/a/src/index.ts"), fileNode("exact", "src/index.ts"),
    ]);
    expect((await findFileNode(client, "src/index.ts", { scope: SCOPE, suffixMatch: true }))?.id).toBe("exact");
  });

  it("lets a search failure reach the caller", async () => {
    const search = vi.fn(async () => { throw new Error("backend down"); });
    await expect(findFileNode({ search } as unknown as Pick<IxClient, "search">, "src/lib.ts", { scope: SCOPE }))
      .rejects.toThrow("backend down");
  });
});

describe("fileUri: a node's file path, read once", () => {
  it("reads either provenance spelling, keeps case and uses / separators", () => {
    expect(fileUri(fileNode("a", "Src/Lib.ts") as never)).toBe("Src/Lib.ts");
    expect(fileUri(fileNode("b", "src\\win\\Lib.ts", "source_uri") as never)).toBe("src/win/Lib.ts");
    expect(fileUri({ id: "c" } as never)).toBe("");
    expect(fileUri(undefined)).toBe("");
  });
});

describe("resolveCallList: the one callee-list resolver", () => {
  it("names each callee in edge order and marks the ones it cannot name", async () => {
    const entity = vi.fn(async (id: string) => {
      if (id === "c-missing") throw new Error("404");
      if (id === "c-raw") return { node: { kind: "function", name: "0123456789abcdef0123456789abcdef", provenance: {} } };
      return { node: { kind: "function", name: "", attrs: { name: "helper" }, provenance: { source_uri: "src/helper.ts" } } };
    });
    const refs = await resolveCallList({ entity } as unknown as IxClient, [
      { src: "t", dst: "c-ok" }, { src: "t", dst: "c-raw" }, { src: "t", dst: "c-missing" },
    ]);
    expect(refs.map((r) => [r.name, r.resolved])).toEqual([
      ["helper", true],
      ["0123456789abcdef0123456789abcdef", false],
      ["c-missing", false],
    ]);
    expect(refs[0]).toMatchObject({ id: "c-ok", kind: "function", path: "src/helper.ts" });
    expect(refs[2]).toMatchObject({ diagnostic: "unresolved_call_target" });
  });
});

describe("the lookups are defined once", () => {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const DEFINITION = /\bfunction\s+(findFileNode|resolveCallList)\b/;
  const HOME: Record<string, string> = { findFileNode: "file-node.ts", resolveCallList: "explain/facts.ts" };

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("no other CLI source file defines findFileNode or resolveCallList", () => {
    const offenders: string[] = [];
    for (const file of sources(cliDir)) {
      const rel = relative(cliDir, file).split("\\").join("/");
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = DEFINITION.exec(line);
        if (m && HOME[m[1]!] !== rel) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
