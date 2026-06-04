import { describe, expect, it } from "vitest";

import { loadExistingHashes } from "../commands/ingest.js";

type Row = { workspaceId: string | null; uri: string; hash: string };

// Stub the workspace-scoped source-hashes endpoint. Records what was queried and
// returns the configured rows (each tagged with its workspace_id, like the server).
function stubClient(rows: Row[]) {
  const calls: Array<{ uris: string[]; workspaceIds?: string[] }> = [];
  return {
    calls,
    getSourceHashes: async (uris: string[], workspaceIds?: string[]) => {
      calls.push({ uris, workspaceIds });
      // Mimic the server: return rows whose uri was asked for (and, if workspaceIds
      // given, whose workspace is in scope).
      return rows.filter(r => uris.includes(r.uri) && (!workspaceIds || workspaceIds.length === 0 || (r.workspaceId != null && workspaceIds.includes(r.workspaceId))));
    },
  };
}

describe("loadExistingHashes — workspace-scoped baseline (Ix#225 gap 3)", () => {
  it("matches each file to ITS OWN workspace's hash, never another workspace's", async () => {
    // Two files share the member-relative uri "src/x.ts" but live in different
    // workspaces with DIFFERENT stored hashes. Each must get its own.
    const client = stubClient([
      { workspaceId: "wsA1aaaa", uri: "src/x.ts", hash: "hashA" },
      { workspaceId: "wsB2bbbb", uri: "src/x.ts", hash: "hashB" },
    ]);
    const toRel = (abs: string) => abs.replace(/^\/(a|b)\//, ""); // /a/src/x.ts -> src/x.ts
    const wsOf = (abs: string) => (abs.startsWith("/a/") ? "wsA1aaaa" : "wsB2bbbb");
    const out = await loadExistingHashes(client, ["/a/src/x.ts", "/b/src/x.ts"], toRel, wsOf);

    expect(out.get("/a/src/x.ts")).toBe("hashA"); // A's own hash, NOT hashB
    expect(out.get("/b/src/x.ts")).toBe("hashB");
    // It must send the workspace scope so the server can bound + tag rows.
    expect(client.calls[0].workspaceIds?.sort()).toEqual(["wsA1aaaa", "wsB2bbbb"]);
    expect(client.calls[0].uris).toEqual(["src/x.ts"]); // deduped
  });

  it("returns no hash for a file whose workspace has no stored row (fresh repo, identical path elsewhere)", async () => {
    // Only workspace A has src/common.ts; a fresh workspace B querying the same uri
    // must NOT inherit A's hash (the cross-workspace collision that wrong-skipped).
    const client = stubClient([{ workspaceId: "wsA1aaaa", uri: "src/common.ts", hash: "hashA" }]);
    const toRel = (abs: string) => abs.replace(/^\/b\//, "");
    const out = await loadExistingHashes(client, ["/b/src/common.ts"], toRel, () => "wsB2bbbb");
    expect(out.has("/b/src/common.ts")).toBe(false); // re-ingested, not matched to A
  });

  it("returns an empty map (not a throw) when the lookup fails", async () => {
    const failing = { getSourceHashes: async () => { throw new Error("network"); } };
    const out = await loadExistingHashes(failing, ["/a.ts"], a => a, () => "ws");
    expect(out.size).toBe(0);
  });
});
