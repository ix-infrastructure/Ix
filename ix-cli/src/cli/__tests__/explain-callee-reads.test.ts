// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import type { IxClient } from "../../client/api.js";
import { IxHttpError } from "../../client/http-error.js";
import { collectFacts } from "../explain/facts.js";

/**
 * `ix explain` names the target's callees. It used to read them one entity at
 * a time (up to 20 reads); it now reads them in one `POST /v1/nodes` when the
 * backend serves it, and uses one expansion on older backends (Ix#931).
 * Missing nodes never trigger individual probes. The list stays the same.
 */

const TARGET = "00000000-0000-0000-0000-0000000000aa";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
/** A CALLS edge to an id with no node behind it (a graph built before tree-sitter/1.28). */
const DANGLING = "00000000-0000-0000-0000-0000000000dd";
/** A node whose name is a raw id: listed, but unresolved. */
const RAW = "00000000-0000-0000-0000-0000000000ee";

const nodeOf = (id: string, name: string, path: string): Record<string, unknown> => ({
  id, kind: "function", name, attrs: { name }, provenance: { sourceUri: path },
});

const NODES: Record<string, Record<string, unknown>> = {
  [TARGET]: nodeOf(TARGET, "runJob", "src/job.ts"),
  [A]: nodeOf(A, "fetchRows", "src/rows.ts"),
  [B]: nodeOf(B, "saveRows", "src/save.ts"),
  [C]: { id: C, kind: "method", name: "", attrs: { name: "close" }, provenance: { source_uri: "src/conn.ts" } },
  [RAW]: nodeOf(RAW, "1234abcd-0000-0000-0000-000000000000", "src/raw.ts"),
};

/** Edge order on purpose not id order; B twice, as two call sites can be. */
const CALLEES = [B, DANGLING, A, C, B, RAW];

interface Recorder {
  entityReads: string[];
  batchReads: Array<{ ids: string[]; fields?: string }>;
}

type BatchBehaviour =
  | "serve"
  | "absent"
  | { throws: string }
  | { strip: string[] }
  | { answer: unknown };

function graph(endpoint: string, batch: BatchBehaviour, rec: Recorder): IxClient {
  const client: Record<string, unknown> = {
    endpoint,
    async entity(id: string) {
      if (id !== TARGET) rec.entityReads.push(id);
      const node = NODES[id];
      if (!node) throw new Error(`404: no entity ${id}`);
      return {
        node,
        claims: [],
        decisions: [],
        edges: id === TARGET
          ? CALLEES.map((dst, i) => ({ id: `e${i}`, src: TARGET, dst, predicate: "CALLS" }))
          : [],
      };
    },
    async expand(id: string, options: { direction: string; predicates: string[] }) {
      return { nodes: id === TARGET && options.direction === "out" && options.predicates.includes("CALLS")
        ? Object.values(NODES).filter((node) => node.id !== TARGET) : [], edges: [] };
    },
    async provenance(id: string) {
      return { entityId: id, chain: [] };
    },
  };
  client.nodes = async (ids: string[], fields?: string) => {
    if (batch === "absent") throw new IxHttpError(404, "Not Found");
    rec.batchReads.push({ ids: [...ids], fields });
    if (typeof batch === "object" && "throws" in batch) {
      // As IxClient fails: a typed error carrying the status (#940), which is what `routeMissing` reads.
      const [status, body = ""] = batch.throws.split(": ");
      throw new IxHttpError(Number(status), body);
    }
    if (typeof batch === "object" && "answer" in batch) return batch.answer;
    const strip = typeof batch === "object" && "strip" in batch ? batch.strip : [];
    const live = ids.filter((id) => NODES[id]);
    return {
      rev: 7,
      nodes: live.map((id) => {
        const n = { ...NODES[id] };
        for (const field of strip) delete n[field];
        return n;
      }),
      missing: ids.filter((id) => !NODES[id]),
    };
  };
  return client as unknown as IxClient;
}

let endpoints = 0;
/** A fresh endpoint per run, so one test's "route missing" memo never reaches another. */
const freshEndpoint = () => `http://callee-reads-${++endpoints}.test:8090`;

async function callList(batch: BatchBehaviour, endpoint = freshEndpoint()) {
  const rec: Recorder = { entityReads: [], batchReads: [] };
  const facts = await collectFacts(graph(endpoint, batch, rec), TARGET, "runJob", "function");
  return { list: facts.callList, rec };
}

describe("ix explain callee reads", () => {
  it("reads the callees in one batch without probing missing ids", async () => {
    const { rec } = await callList("serve");

    expect(rec.batchReads).toEqual([{ ids: [B, DANGLING, A, C, RAW], fields: "full" }]);
    expect(rec.entityReads).toEqual([]);
  });

  it("lists the same callees, in edge order, as the expansion fallback", async () => {
    const before = await callList("absent");
    const after = await callList("serve");

    expect(before.rec.entityReads).toEqual([]);
    expect(after.list).toEqual(before.list);
    expect(after.list?.map((r) => r.name)).toEqual(["saveRows", DANGLING, "fetchRows", "close", "saveRows", "1234abcd-0000-0000-0000-000000000000"]);
    expect(after.list?.map((r) => r.resolved)).toEqual([true, false, true, true, true, false]);
    expect(after.list?.[0]).toMatchObject({ kind: "function", id: B, path: "src/save.ts" });
    expect(after.list?.[3]).toMatchObject({ kind: "method", id: C, path: "src/conn.ts" });
  });

  it("expands when the backend has no batched read, and remembers that", async () => {
    const endpoint = freshEndpoint();
    const before = await callList("absent");
    const first = await callList({ throws: "404: Not Found" }, endpoint);

    expect(first.list).toEqual(before.list);
    expect(first.rec.entityReads).toEqual([]);

    const second = await callList("serve", endpoint);
    expect(second.rec.batchReads).toEqual([]);
    expect(second.rec.entityReads).toEqual([]);
    expect(second.list).toEqual(before.list);
  });

  it("retries the batch route after the capability cache expires", async () => {
    const endpoint = freshEndpoint();
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await callList({ throws: "404: Not Found" }, endpoint);
      time.mockReturnValue(now + 10 * 60_000);
      const next = await callList("serve", endpoint);
      expect(next.rec.batchReads).toHaveLength(1);
      expect(next.rec.entityReads).toEqual([]);
      expect(next.list?.[0]).toMatchObject({ name: "saveRows", path: "src/save.ts" });
    } finally {
      time.mockRestore();
    }
  });

  it("keeps transient failures best-effort without disabling the next batched read", async () => {
    const endpoint = freshEndpoint();
    const failed = await callList({ throws: "503: busy" }, endpoint);

    expect(failed.list).toHaveLength(CALLEES.length);
    expect(failed.list?.every((ref) => !ref.resolved && "diagnostic" in ref)).toBe(true);
    expect(failed.rec.entityReads).toEqual([]);

    const next = await callList("serve", endpoint);
    expect(next.rec.batchReads).toHaveLength(1);
    expect(next.rec.entityReads).toEqual([]);
  });

  it("recovers paths in one expansion when the batch leaves out provenance", async () => {
    const before = await callList("absent");
    const stripped = await callList({ strip: ["provenance"] });

    expect(stripped.list).toEqual(before.list);
    expect(stripped.rec.entityReads).toEqual([]);
  });

  it("ignores an answer that is not the expected shape", async () => {
    const before = await callList("absent");
    for (const answer of [null, {}, { nodes: "x" }, { nodes: [null, 3, { id: 9 }] }]) {
      const odd = await callList({ answer });
      expect(odd.list).toEqual(before.list);
      expect(odd.rec.entityReads).toEqual([]);
    }
  });
});
