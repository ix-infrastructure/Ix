// Copyright 2026 Ix Infrastructure Inc.

// Real HTTP writes and reads on the harness's disposable database. Source
// and evidence are paired fixtures so this test has no extractor dependency.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IxClient } from "../../src/client/api.js";
import { BULK_DELETES_SINCE, releaseAtLeast } from "../../src/client/features.js";
import { httpStatusOf } from "../../src/client/http-error.js";
import type { GraphNode, GraphPatchPayload, PatchOp, UpsertNodeOp } from "../../src/client/types.js";
import { e2eEnv, resetBackend, type E2eEnv } from "./harness.js";

type Route = "single" | "bulk";
type Kind = "function" | "method";
const routes: Route[] = ["single", "bulk"];
const uri = "src/job.ts";
const workspaceId = "6636fbb6-d0ad-44ec-ac23-e682ce89cad9";
const ownerId = "3acfd478-ef71-4219-b4a3-8b042ed368c2";
const slotId = "864a33aa-7bfa-4670-9a71-c7cbbb32aac8";
const extractor = "ix-e2e/behavior-wire-v1";

const nestedBody = [
  '  let status = "queued"',
  "  if (ready) {",
  '    if (status === "queued") {',
  '      status = "running"',
  "    } else {",
  '      status = "blocked"',
  "    }",
  "  }",
];
const singleBody = ['  let status = "queued"', '  status = "done"'];

function source(kind: Kind, body: string[]): string {
  const open = kind === "method" ? "class Job { start(ready: boolean) {" : "function start(ready: boolean) {";
  return [open, ...body, kind === "method" ? "} }" : "}"].join("\n");
}

const slot = { slotId, slotName: "status", slotKind: "local" };
const ready = { conditionKey: ["identifier", "ready"], arm: "then", span: [3, 6, 3, 11] };
const queued = { conditionKey: ["strictEqual", "status", ["string", "queued"]], span: [4, 8, 4, 27] };
const nested = {
  coverage: "complete",
  writes: [
    {
      ...slot, id: "write-running",
      observed: { to: { kind: "string", value: "running" }, assignment: [5, 6, 5, 24], guards: [ready, { ...queued, arm: "then" }] },
      inferred: { from: { kind: "string", value: "queued" }, basis: "direct-same-slot-equality", guardIndex: 1 },
    },
    {
      ...slot, id: "write-blocked",
      observed: { to: { kind: "string", value: "blocked" }, assignment: [7, 6, 7, 24], guards: [ready, { ...queued, arm: "else" }] },
      inferred: { from: "unknown" },
    },
  ],
};
const one = {
  coverage: "complete",
  writes: [{
    ...slot, id: "write-done",
    observed: { to: { kind: "string", value: "done" }, assignment: [3, 2, 3, 17], guards: [] },
    inferred: { from: "unknown" },
  }],
};
const empty = { coverage: "complete", writes: [] };
type Evidence = typeof nested | typeof one | typeof empty;

const original = source("method", nestedBody);
const updated = source("method", singleBody);
const removalCases = [
  { change: "final write removed", code: source("method", ["  void ready"]) },
  // Same qualified key and method kind, now a signature with no executable body.
  { change: "method becomes abstract", code: "abstract class Job { abstract start(ready: boolean): void }" },
];
const unrelatedAttrs = { line_start: 1, language: "typescript", role: "production", role_source: "inherited_from_file" };

let env: E2eEnv;
let client: IxClient;
let bulkDeletes: boolean;

beforeAll(async () => {
  env = e2eEnv();
  client = new IxClient(env.endpoint, undefined, { token: env.token });
  const { release_version: release } = await client.health();
  const supported = releaseAtLeast(release, BULK_DELETES_SINCE);
  if (supported === null) throw new Error(`Cannot identify backend release at ${env.endpoint}: ${release}`);
  bulkDeletes = supported;
});
beforeEach(async () => { await resetBackend(env); });
afterAll(async () => { if (env && client) await resetBackend(env); });

function sourceHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

async function head(): Promise<number> {
  const record = await client.currentRevision();
  const rev = typeof record === "object" && record !== null && "rev" in record ? record.rev : record;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) throw new Error(`Invalid head: ${JSON.stringify(record)}`);
  return rev;
}

async function patch(code: string, op: PatchOp, previous?: GraphPatchPayload, fileUri = uri): Promise<GraphPatchPayload> {
  return {
    patchId: randomUUID(), actor: "ix-e2e", timestamp: new Date().toISOString(), baseRev: await head(),
    source: { uri: fileUri, sourceHash: sourceHash(code), sourceType: "code", extractor, workspaceId },
    ops: [op], replaces: previous ? [previous.patchId] : [],
  };
}

function send(route: Route, payload: GraphPatchPayload) {
  return route === "single" ? client.commitPatch(payload) : client.commitPatchBulk([payload]);
}

function symbolOp(code: string, behavior: Evidence | undefined, kind: Kind, id = ownerId): UpsertNodeOp {
  return {
    type: "UpsertNode", id, name: "start", kind,
    attrs: { ...unrelatedAttrs, line_end: code.split("\n").length, ...(behavior === undefined ? {} : { behavior_v1: behavior }) },
  };
}

async function upsert(route: Route, code: string, behavior: Evidence | undefined, previous?: GraphPatchPayload, kind: Kind = "method") {
  const payload = await patch(code, symbolOp(code, behavior, kind), previous);
  const result = await send(route, payload);
  expect(result.status).toBe("Ok");
  return payload;
}

// Check the positive identity and current source revision even when the
// expected attribute is absent. A missing/stale node cannot pass a clear.
function expectSymbol(node: GraphNode | undefined, code: string, behavior: Evidence | undefined, kind: Kind = "method") {
  if (!node) throw new Error(`Expected live ${kind} ${ownerId} from ${uri}`);
  expect(node).toMatchObject({
    id: ownerId, name: "start", kind,
    attrs: { ...unrelatedAttrs, line_end: code.split("\n").length },
    provenance: { extractor },
  });
  const provenance = node.provenance as GraphNode["provenance"] & { source_hash?: string };
  expect(provenance.sourceUri ?? provenance.source_uri).toBe(uri);
  expect(provenance.sourceHash ?? provenance.source_hash).toBe(sourceHash(code));
  if (behavior === undefined) expect(node.attrs).not.toHaveProperty("behavior_v1");
  else expect(node.attrs.behavior_v1).toStrictEqual(behavior);
}

async function latest() {
  return (await client.entity(ownerId))?.node;
}

async function historical(rev: number) {
  const context = await client.contextForNode(ownerId, { depth: "full", asOfRev: rev });
  expect(context.metadata.asOfRev).toBe(rev);
  return context.nodes.find(n => n.id === ownerId);
}

async function remove(route: Route, previous: GraphPatchPayload) {
  const deletion = await patch("", { type: "DeleteNode", id: ownerId }, previous);
  // Matches ingest's route selection. 1.0.30 does not apply bulk deletes.
  const result = await send(bulkDeletes ? route : "single", deletion);
  expect(result.status).toBe("Ok");
}

async function expectDeleted() {
  try {
    expect(await latest()).toBeFalsy();
  } catch (error) {
    if (httpStatusOf(error) !== 404) throw error;
  }
}

describe.each(routes)("behavior_v1 via %s upserts", route => {
  it.each(["function", "method"] as const)("round-trips nested evidence on a %s", async kind => {
    const code = source(kind, nestedBody);
    await upsert(route, code, nested, undefined, kind);
    expectSymbol(await latest(), code, nested, kind);
  });

  it("replaces two writes and their guards with one different write", async () => {
    const first = await upsert(route, original, nested);
    expectSymbol(await latest(), original, nested);
    await upsert(route, updated, one, first);
    expectSymbol(await latest(), updated, one);
  });

  describe.each(removalCases)("$change", ({ code }) => {
    it.each([
      { encoding: "omitted attribute", value: undefined },
      { encoding: "explicit empty envelope", value: empty },
    ])("clears earlier evidence with $encoding and preserves the method", async ({ value }) => {
      const first = await upsert(route, updated, one);
      expectSymbol(await latest(), updated, one);
      await upsert(route, code, value, first);
      expectSymbol(await latest(), code, value);
    });
  });

  it("replays the identical patch without a new revision or duplicate evidence", async () => {
    const first = await upsert(route, updated, one);
    expectSymbol(await latest(), updated, one);
    const before = await head();
    const replay = await send(route, first);
    expect(["Idempotent", "Ok"]).toContain(replay.status);
    expect(await head()).toBe(before);
    expectSymbol(await latest(), updated, one);
  });

  it("deletes the live symbol using the supported delete route", async () => {
    const first = await upsert(route, updated, one);
    expectSymbol(await latest(), updated, one);
    await remove(route, first);
    await expectDeleted();
  });

  it.each(["update", "deletion"] as const)("retrieves each committed revision after %s", async last => {
    const first = await upsert(route, original, nested);
    expectSymbol(await latest(), original, nested);
    const firstRev = await head();
    const second = await upsert(route, updated, one, first);
    expectSymbol(await latest(), updated, one);
    const secondRev = await head();
    expect(secondRev).toBeGreaterThan(firstRev);
    if (last === "deletion") {
      await remove(route, second);
      await expectDeleted();
    }
    expectSymbol(await historical(firstRev), original, nested);
    expectSymbol(await historical(secondRev), updated, one);
  });

  it("finds the live symbol in compact context and its exact evidence in full context", async () => {
    await upsert(route, original, nested);
    const compact = await client.contextForNode(ownerId, { depth: "compact" });
    expect([...(compact.nodeSummaries ?? []), ...(compact.nodes ?? [])].map(n => n.id)).toContain(ownerId);
    const full = await client.contextForNode(ownerId, { depth: "full" });
    expectSymbol(full.nodes.find(n => n.id === ownerId), original, nested);
  });
});

it("keeps evidence scoped to its symbol in a multi-file bulk request", async () => {
  const otherId = randomUUID();
  const otherUri = "src/other.ts";
  const otherSource = source("function", singleBody);
  const first = await patch(original, symbolOp(original, nested, "method"));
  const other = await patch(otherSource, symbolOp(otherSource, one, "function", otherId), undefined, otherUri);
  const result = await client.commitPatchBulk([first, other]);
  expect(result.status).toBe("Ok");
  expectSymbol(await latest(), original, nested);
  const { node } = await client.entity(otherId);
  expect(node).toMatchObject({ id: otherId, kind: "function", name: "start", attrs: unrelatedAttrs });
  expect(node.provenance.sourceUri ?? node.provenance.source_uri).toBe(otherUri);
  expect(node.attrs.behavior_v1).toStrictEqual(one);
});
