import { describe, expect, it, vi } from "vitest";

import { IxClient } from "../../client/api.js";

/**
 * `ix context` resolves its target and then has to ask the backend for the
 * graph around it. It used to ask by NAME, which made the backend re-run the
 * search the resolver had just done — the single most expensive call the CLI
 * makes, measured at 10.6 s against 0.06 s for the id form on the same graph.
 *
 * Worse than slow: the re-derived seeds can land on a different node of the
 * same name. `README.md` resolved to one id and came back seeded on
 * `mcp/node_modules/serve-static/README.md`, with the resolved id in neither
 * the seed list nor the returned nodes.
 */
describe("contextForNode", () => {
  function capture() {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ nodes: [], edges: [], claims: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return calls;
  }

  it("sends the node id as a slice, never a name", async () => {
    const calls = capture();
    await new IxClient("http://x").contextForNode("11111111-2222-3333-4444-555555555555");
    const body = calls[0].body;

    expect(body.slices).toEqual([
      {
        type: "nodes",
        nodeIds: ["11111111-2222-3333-4444-555555555555"],
        expand: true,
        hops: 1,
      },
    ]);
    // The whole point: no free-text query for the backend to re-search.
    expect(body.query).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("passes depth through rather than pinning it to full", async () => {
    const calls = capture();
    await new IxClient("http://x").contextForNode("11111111-2222-3333-4444-555555555555", {
      depth: "compact",
      asOfRev: 2000,
    });
    // `--depth` has to keep meaning what it says: compact and standard return
    // the summarized graph, full returns whole nodes plus claims. Hardcoding
    // full would silently ignore the flag and change every bundle's size.
    expect(calls[0].body.depth).toBe("compact");
    expect(calls[0].body.asOfRev).toBe(2000);
    vi.unstubAllGlobals();
  });
});

describe("context.ts call sites", () => {
  it("has no by-name context call left in the command", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "commands", "context.ts"),
      "utf8",
    );
    // Two call sites, and both must convert. Leaving one behind makes `--diff`
    // compare a by-id bundle against a by-name one and report the entire graph
    // as changed on the first run after upgrade.
    expect(src).not.toContain("client.query(resolved.name");
    expect(src.match(/client\.contextForNode\(resolved\.id/g) ?? []).toHaveLength(2);
  });
});
