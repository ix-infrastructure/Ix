import { describe, expect, it } from "vitest";

import { loadExistingHashes } from "../commands/ingest.js";

// A stub that records the uris queried and returns a fixed uri -> hash map.
function stubClient(serverHashes: Record<string, string>) {
  const queried: string[][] = [];
  return {
    queried,
    getSourceHashes: async (uris: string[]) => {
      queried.push(uris);
      const out = new Map<string, string>();
      for (const u of uris) if (serverHashes[u] !== undefined) out.set(u, serverHashes[u]);
      return out;
    },
  };
}

describe("loadExistingHashes baseline (Ix#225 member-relative source_uri)", () => {
  it("maps server hashes back onto absolute paths via the relative key", async () => {
    const client = stubClient({ "src/a.ts": "h1", "src/b.ts": "h2" });
    const toRel = (abs: string) => abs.replace(/^\/repo\//, "");
    const out = await loadExistingHashes(client, ["/repo/src/a.ts", "/repo/src/b.ts"], toRel);
    expect(out.get("/repo/src/a.ts")).toBe("h1");
    expect(out.get("/repo/src/b.ts")).toBe("h2");
  });

  it("DROPS ambiguous member-relative uris so a colliding file is never matched to another member's hash", async () => {
    // Co-ingest: app/src/index.ts and lib/src/index.ts BOTH map to member-relative
    // "src/index.ts". The global source-hashes route cannot tell them apart, so the
    // collision must be excluded (both files re-ingested, never wrong-skipped).
    const client = stubClient({ "src/index.ts": "hX", "src/only-app.ts": "hA" });
    const memberRel = (abs: string) => abs.replace(/^\/sys\/(app|lib)\//, "");
    const out = await loadExistingHashes(
      client,
      ["/sys/app/src/index.ts", "/sys/lib/src/index.ts", "/sys/app/src/only-app.ts"],
      memberRel,
    );
    // The colliding uri must NOT be queried and must NOT resolve to a hash.
    expect(client.queried[0]).not.toContain("src/index.ts");
    expect(out.has("/sys/app/src/index.ts")).toBe(false);
    expect(out.has("/sys/lib/src/index.ts")).toBe(false);
    // The unambiguous file still resolves normally.
    expect(out.get("/sys/app/src/only-app.ts")).toBe("hA");
  });

  it("returns an empty map (not a throw) when the lookup fails", async () => {
    const failing = { getSourceHashes: async () => { throw new Error("network"); } };
    const out = await loadExistingHashes(failing, ["/repo/a.ts"], (a) => a);
    expect(out.size).toBe(0);
  });
});
