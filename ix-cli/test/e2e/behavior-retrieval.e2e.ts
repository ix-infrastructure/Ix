// Copyright 2026 Ix Infrastructure Inc.
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { contextBundleSchema } from "../../src/cli/context-bundle-schema.js";
import type { ContextBundle } from "../../src/cli/context/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { IxClient } from "../../src/client/api.js";
import { loadIngestionModules } from "../../src/cli/commands/ingestion-loader.js";
import {
  checkout,
  cleanupScratch,
  e2eEnv,
  headers,
  ix,
  resetBackend,
  workspaceId,
} from "./harness.js";

const env = e2eEnv();
const api = new IxClient(env.endpoint, undefined, { token: env.token });
const fixture = mkdtempSync(join(tmpdir(), "ix-retrieval-fixture-"));
const original = `export class Job {
  start() {
    if (this.status === "queued") this.status = "running";
  }
  stop() {
    this.status = "done";
  }
}
`;
writeFileSync(join(fixture, "job.ts"), original);
beforeEach(() => resetBackend(env));
afterAll(() => {
  cleanupScratch();
  rmSync(fixture, { recursive: true, force: true });
});

it("R1 verifies complete contained member attributes and a bounded, historical seed-only slice", async () => {
  const co = checkout(fixture);
  ix(env, co, ["map", ".", "--silent"]);
  const [, core] = await loadIngestionModules();
  const id = (name: string) => core.symbolNodeId(workspaceId(co), "job.ts", name);
  const owners = [id("Job.start"), id("Job.stop")];
  const nodes = await Promise.all(owners.map(async (key) => (await api.entity(key)).node));
  for (const node of nodes) expect(node.attrs.behavior_v1).toBeDefined();
  const members = await api.expand(id("Job"), { predicates: ["CONTAINS"], direction: "out" });
  for (const node of nodes) {
    expect(members.edges).toContainEqual(
      expect.objectContaining({ src: id("Job"), dst: node.id, predicate: "CONTAINS" }),
    );
    expect(members.nodes.find((n) => n.id === node.id)).toMatchObject({
      attrs: node.attrs,
      provenance: node.provenance,
    });
  }
  const found = await api.search("start", { nameOnly: true, workspaceId: workspaceId(co) });
  expect(found.find((n) => n.id === owners[0])).toMatchObject({
    attrs: nodes[0].attrs,
    provenance: nodes[0].provenance,
  });
  const rev = (await api.contextForNode(id("Job"), { depth: "full" })).metadata.asOfRev;
  const past = JSON.parse(
    ix(env, co, [
      "context",
      id("Job"),
      "--as-of-rev",
      String(rev),
      "--max-chars",
      "24000",
      "--format",
      "json",
    ]).stdout,
  );
  expect(projection(past)?.slots[0]?.sites).toHaveLength(2);
  const byName = JSON.parse(
    ix(env, co, [
      "context",
      "Job.start",
      "--path",
      "job.ts",
      "--as-of-rev",
      String(rev),
      "--max-chars",
      "24000",
      "--format",
      "json",
    ]).stdout,
  );
  expect(projection(byName)?.slots[0]?.sites[0]?.ownerId).toBe(owners[0]);
  for (const depth of ["compact", "standard", "full"]) {
    const ctx = await api.contextForNode(id("Job"), { depth, asOfRev: rev });
    expect(ctx.metadata.asOfRev).toBe(rev);
    const edges = ctx.edges.length ? ctx.edges : (ctx.edgeSummaries ?? []);
    for (const node of nodes)
      expect(edges).toContainEqual(
        expect.objectContaining({ src: id("Job"), dst: node.id, predicate: "CONTAINS" }),
      );
  }
  renameSync(join(co.dir, "job.ts"), join(co.dir, "archived.ts"));
  ix(env, co, ["map", ".", "--silent"]);
  writeFileSync(join(co.dir, "job.ts"), original.replace('"running"', '"reused"'));
  ix(env, co, ["map", ".", "--silent"]);
  const seeds = [id("Job"), ...owners];
  const r = await fetch(env.endpoint + "/v1/context", {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({
      slices: [{ type: "nodes", nodeIds: seeds, expand: false, hops: 0 }],
      depth: "full",
      asOfRev: rev,
    }),
  });
  expect(r.status).toBe(200);
  const historical = await r.json();
  expect(historical.metadata.asOfRev).toBe(rev);
  expect(historical.nodes.map((n: { id: string }) => n.id).sort()).toEqual(seeds.sort());
  for (const node of nodes)
    expect(historical.nodes.find((n: { id: string }) => n.id === node.id)).toMatchObject({
      attrs: node.attrs,
      provenance: node.provenance,
    });
});

const projection = (bundle: ContextBundle) =>
  bundle.evidence.find((row) => row.kind === "behavior")?.behavior;
const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

it("R2 maps an ordinary class and explains its cross-method state changes over real MCP stdio", async () => {
  const co = checkout(fixture);
  ix(env, co, ["map", "."]);
  const client = new Client({ name: "behavior-retrieval-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    cwd: co.dir,
    env: {
      ...(process.env as Record<string, string>),
      IX_HOME: co.ixHome,
      IX_ENDPOINT: env.endpoint,
      IX_NO_UPDATE_CHECK: "1",
    },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "ix_context", arguments: { target: "Job" } });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result.content);
    for (const phrase of [
      "start writes this.status",
      "guard true",
      "queued",
      "running",
      "stop writes this.status",
      "candidate prior unknown",
      "job.ts",
      "class view covers returned members only",
    ])
      expect(text).toContain(phrase);
    expect(result.structuredContent).toBeUndefined();
    const normalJson = await client.callTool({
      name: "ix_context",
      arguments: { target: "Job", structured: true },
    });
    const bounded = projection(normalJson.structuredContent as unknown as ContextBundle)!;
    const count = bounded.slots.reduce((total, slot) => total + slot.sites.length, 0);
    expect(count).toBeGreaterThan(0);
    expect(count + bounded.omittedWrites).toBe(2);

    const structured = await client.callTool({
      name: "ix_context",
      arguments: { target: "Job", structured: true, max_chars: 24000 },
    });
    const view = projection(structured.structuredContent as unknown as ContextBundle)!;
    expect(view.slots).toHaveLength(1);
    expect(view.slots[0].sites.map((s) => s.ownerName).sort()).toEqual(["start", "stop"]);
    const start = view.slots[0].sites.find((s) => s.ownerName === "start")!;
    expect(start.observed.assignment).toEqual([3, 34, 3, 57]);
    expect(start.inferred.from).toEqual({ kind: "string", value: "queued" });
    expect(start.observed.guards[0]).toMatchObject({ arm: "then", sameSlot: true });
    expect(start.extraction.coverage).toBe("complete");
    expect(view.scope).toBe("returned-members");
    expect(
      JSON.stringify(
        (
          await client.callTool({
            name: "ix_context",
            arguments: { target: "Job", max_chars: 1000 },
          })
        ).content,
      ).length,
    ).toBeLessThan(1200);
    for (const args of [
      ["impact", "Job"],
      ["impact", "Job.start"],
      ["explain", "Job"],
      ["explain", "Job.start", "--raw"],
      ["explain", "Job", "--raw"],
    ]) {
      const data = JSON.parse(ix(env, co, [...args, "--format", "json"]).stdout);
      expect(
        (data.facts ?? data.result ?? data).behavioralEvidence?.slots[0]?.slotId,
        args.join(" "),
      ).toBe(view.slots[0].slotId);
    }
  } finally {
    await client.close();
  }
});

it("R3 preserves selected saved evidence and reports a change even when only citations move", async () => {
  const co = checkout(fixture);
  ix(env, co, ["map", "."]);
  const args = ["--max-chars", "24000", "--format", "json"];
  const bundle = JSON.parse(ix(env, co, ["context", "Job", ...args]).stdout);
  const selected = projection(bundle)!;
  expect(selected.slots[0].sites).toHaveLength(2);
  // The same schema guards both saving and loading. A tampered row must not
  // survive when it purports to belong to a different snapshot or owner.
  const wrongRevision = { ...bundle, metadata: { ...bundle.metadata, asOfRev: 99 } };
  const wrongOwner = {
    ...bundle,
    target: { ...bundle.target, id: selected.slots[0].sites[0].ownerId },
  };
  for (const changed of [wrongRevision, wrongOwner]) {
    const sanitized = contextBundleSchema.parse(changed);
    expect(sanitized.evidence.some((row) => row.kind === "behavior")).toBe(false);
    expect(sanitized.evidence.filter((row) => row.kind !== "behavior")).toEqual(
      contextBundleSchema.parse(bundle).evidence.filter((row) => row.kind !== "behavior"),
    );
  }
  ix(env, co, ["context", "Job", "--save", "behavior", ...args]);
  writeFileSync(join(co.dir, "job.ts"), "\n" + original);
  ix(env, co, ["map", "."]);
  const diff = JSON.parse(
    ix(env, co, ["context", "--diff", "behavior", "--format", "json"]).stdout,
  );
  expect(projection(diff.added)?.slots[0].sites.map((s) => s.id)).toEqual(
    selected.slots[0].sites.map((s) => s.id),
  );
  expect(projection(diff.added)).not.toEqual(selected);
  expect(projection(diff.removed)).toEqual(selected);
  const resumed = JSON.parse(
    ix(env, co, ["context", "--resume", "behavior", "--format", "json"]).stdout,
  );
  expect(projection(resumed.bundle ?? resumed)).toEqual(selected);
});

it("R4 reads old identities and provenance after edits, deletion, rename and name reuse", async () => {
  const co = checkout(fixture);
  const change = (name: string, src: string) => writeFileSync(join(co.dir, name), src);
  const map = () => ix(env, co, ["map", "."]);
  map();
  const [, core] = await loadIngestionModules();
  const classId = core.symbolNodeId(workspaceId(co), "job.ts", "Job");
  const rev = (await api.contextForNode(classId, { depth: "full" })).metadata.asOfRev;
  const prior = projection(
    JSON.parse(ix(env, co, ["context", "Job", "--max-chars", "24000", "--format", "json"]).stdout),
  )!;
  change("job.ts", original.replaceAll("queued", "ready"));
  map();
  renameSync(join(co.dir, "job.ts"), join(co.dir, "archived.ts"));
  map();
  const missing = ix(
    env,
    co,
    ["context", "NoSuchHistoricalOwner", "--as-of-rev", String(rev), "--format", "json"],
    true,
  );
  expect(missing.status).toBe(3);
  expect(JSON.parse(missing.stdout).message).toContain(`unavailable at revision ${rev}`);
  const start = prior.slots[0].sites.find((s) => s.ownerName === "start")!;
  for (const target of [classId, "Job", "Job.start", start.ownerId, "start"]) {
    const old = JSON.parse(
      ix(env, co, [
        "context",
        target,
        "--as-of-rev",
        String(rev),
        "--max-chars",
        "24000",
        "--format",
        "json",
      ]).stdout,
    );
    const view = projection(old);
    if (target === start.ownerId) {
      expect(view?.slots[0]?.sites[0], target).toEqual(start);
    } else {
      // Rewriting the same file can retire its original containment edges on these releases.
      // An old node can survive by ID while its class relationships are unavailable.
      expect(view, target).toMatchObject({
        unavailable: "revision evidence unavailable",
        slots: [],
      });
    }
    expect(view?.revision).toBe(rev);
  }
  change("job.ts", original.replaceAll("running", "reused"));
  map();
  for (const depth of ["compact", "standard", "full"]) {
    const old = JSON.parse(
      ix(env, co, [
        "context",
        classId,
        "--as-of-rev",
        String(rev),
        "--depth",
        depth,
        "--max-chars",
        "24000",
        "--format",
        "json",
      ]).stdout,
    );
    expect(projection(old)).toMatchObject({
      revision: rev,
      unavailable: "revision evidence unavailable",
      slots: [],
    });
    const leaf = JSON.parse(
      ix(env, co, [
        "context",
        start.ownerId,
        "--as-of-rev",
        String(rev),
        "--depth",
        depth,
        "--max-chars",
        "24000",
        "--format",
        "json",
      ]).stdout,
    );
    expect(projection(leaf)?.slots[0].sites[0]).toEqual(start);
  }
});

it("R5 keeps mapped citations when the source disappears and retires them on the next ordinary map", () => {
  const co = checkout(fixture);
  ix(env, co, ["map", "."]);
  const args = ["context", "Job", "--max-chars", "24000", "--format", "json"];
  const initial = JSON.parse(ix(env, co, args).stdout);
  rmSync(join(co.dir, "job.ts"));
  expect(projection(JSON.parse(ix(env, co, args).stdout))).toEqual(projection(initial));
  writeFileSync(join(co.dir, "job.ts"), "export class Job { start() {return 1;} stop() {} }");
  ix(env, co, ["map", "."]);
  const after = JSON.parse(ix(env, co, args).stdout);
  expect(after.target.id).toBe(initial.target.id);
  expect(projection(after)).toBeUndefined();
  expect(after.entities.map((n: { name: string }) => n.name)).toEqual(
    expect.arrayContaining(["Job", "start", "stop"]),
  );
});

it("renders scoped boolean writes and an unknown prior through default MCP", async () => {
  const co = checkout(fixture);
  writeFileSync(
    join(co.dir, "job.ts"),
    [
      "export class Job {",
      "  stopped=false;",
      "  work(){if(this.stopped)return; tick();}",
      "  stop(){this.stopped=true;}",
      "  resume(){if(this.stopped === true)this.stopped=false;}",
      "  cleanup(){try {tick();} finally {this.stopped=false;}}",
      "}",
    ].join("\n"),
  );
  ix(env, co, ["map", "."]);
  const mcp = new Client({ name: "boolean-pilot", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "mcp"],
      cwd: co.dir,
      env: {
        ...(process.env as Record<string, string>),
        IX_HOME: co.ixHome,
        IX_ENDPOINT: env.endpoint,
        IX_NO_UPDATE_CHECK: "1",
      },
    }),
  );
  try {
    const result = await mcp.callTool({ name: "ix_context", arguments: { target: "Job" } });
    const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
    for (const fact of [
      "stop writes this.stopped = true",
      "candidate prior unknown",
      "resume writes this.stopped = false",
      "candidate prior true",
      "finally arm",
      "execution and frequency unknown",
    ])
      expect(text).toContain(fact);
    expect(text).toContain("cleanup writes");
    const bundle = JSON.parse(
      ix(env, co, ["context", "Job", "--max-chars", "24000", "--format", "json"]).stdout,
    );
    expect(projection(bundle)?.slots).toHaveLength(1);
    expect(
      projection(bundle)
        ?.slots[0].sites.map((w) => w.ownerName)
        .sort(),
    ).toEqual(["cleanup", "resume", "stop"]);
  } finally {
    await mcp.close();
  }
});
