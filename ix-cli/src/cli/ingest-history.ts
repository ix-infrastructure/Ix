// Copyright 2026 Ix Infrastructure Inc.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphPatchPayload, PatchCommitResult } from "../client/types.js";
import { combineSignals, currentRunSignal } from "../client/run-signal.js";
import {
  couplingEdgeId,
  couplingIndex,
  historyCachePath,
  historyId,
  HISTORY_DEFAULTS,
  loadHistory,
  mineHistory,
  saveHistory,
  type HistoryEntity,
  type HistoryOptions,
} from "./git-coupling.js";

/** History patches own edges only, never rewrite a code node's provenance. */
export async function ingestHistory(
  input: {
    root: string;
    workspaceId: string;
    forceGraph?: boolean;
    known: Map<string, Set<string>>;
    fileNodeId: (workspace: string, path: string) => string;
    symbolNodeId: (workspace: string, path: string, key: string) => string;
    commit: (patch: GraphPatchPayload, signal: AbortSignal) => Promise<PatchCommitResult>;
  } & HistoryOptions,
) {
  const signal = combineSignals(
    combineSignals(input.signal, currentRunSignal()),
    AbortSignal.timeout(input.budgetMs ?? HISTORY_DEFAULTS.budgetMs),
  )!;
  const previous = loadHistory(input.root);
  // Re-keying a workspace never authorizes deleting the old namespace's edges.
  const published = previous?.workspaceId === input.workspaceId ? previous : undefined;
  const state = await mineHistory(input.root, previous, { ...input, signal });
  if (!state) return undefined;
  const exists = (e: HistoryEntity) =>
    input.known.has(e.path) && (e.key === undefined || input.known.get(e.path)!.has(e.key));
  // Filter before the top-20 cap so removed endpoints cannot hide a live partner.
  const index = couplingIndex(state, signal, exists);
  signal.throwIfAborted();
  const id = (e: HistoryEntity) =>
    e.key === undefined
      ? input.fileNodeId(input.workspaceId, e.path)
      : input.symbolNodeId(input.workspaceId, e.path, e.key);
  for (const entity of Object.values(index.entities)) entity.id = id(entity);
  const edges = index.edges.map((e) => {
    const src = id(index.entities[e.source]),
      dst = id(index.entities[e.target]);
    return {
      type: "UpsertEdge",
      id: couplingEdgeId(src, dst),
      src,
      dst,
      predicate: "CO_CHANGES",
      attrs: { support: e.support, confidence: e.confidence, last_co_change: e.lastCoChange },
    };
  });
  const edgeIds = new Set(edges.map((e) => e.id));
  const pendingPath = `${historyCachePath(input.root)}.pending`;
  let pending:
    { signature: string; attempt: string; edgeIds: string[]; workspaceId: string } | undefined;
  try {
    pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    if (pending?.workspaceId !== input.workspaceId) pending = undefined;
  } catch {
    /* no unfinished write */
  }
  const oldIds = new Set([...(published?.edgeIds ?? []), ...(pending?.edgeIds ?? [])]);
  const ops = [...oldIds]
    .filter((id) => !edgeIds.has(id))
    .map((id) => ({ type: "DeleteEdge", id }));
  const previousEdges = new Map(
    published?.index?.edges.map((e) => [
      couplingEdgeId(
        id(published.index!.entities[e.source]),
        id(published.index!.entities[e.target]),
      ),
      e,
    ]) ?? [],
  );
  const changedEdges =
    pending || input.forceGraph
      ? edges
      : edges.filter((edge) => {
          const prior = previousEdges.get(edge.id);
          return (
            !prior ||
            prior.support !== edge.attrs.support ||
            prior.confidence !== edge.attrs.confidence ||
            prior.lastCoChange !== edge.attrs.last_co_change
          );
        });
  const allOps = [...ops, ...changedEdges];
  let graphChanged = false;
  let rev: number | undefined;
  state.patchId = published?.patchId;
  if (
    (pending || input.forceGraph || JSON.stringify(published?.index) !== JSON.stringify(index)) &&
    allOps.length
  ) {
    const signature = createHash("sha256")
      .update(JSON.stringify([input.workspaceId, index]))
      .digest("hex");
    const attempt = pending?.signature === signature ? pending.attempt : randomUUID();
    // The journal covers every edge a partial write could have placed. A new
    // HEAD during recovery can delete these too, before the cursor advances.
    mkdirSync(dirname(pendingPath), { recursive: true });
    const temp = `${pendingPath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        signature,
        attempt,
        edgeIds: [...new Set([...oldIds, ...edgeIds])],
        workspaceId: input.workspaceId,
      }),
    );
    renameSync(temp, pendingPath);
    for (let offset = 0; offset < allOps.length; offset += 1000) {
      signal.throwIfAborted();
      const batch = allOps.slice(offset, offset + 1000);
      const hash = createHash("sha256")
        .update(JSON.stringify([attempt, offset, batch]))
        .digest("hex");
      const result = await input.commit(
        {
          patchId: historyId(hash),
          actor: "",
          timestamp: new Date().toISOString(),
          source: {
            uri: `ix:git-history/${offset / 1000}`,
            sourceHash: hash,
            sourceType: "git-history",
            extractor: "git-history/1",
            workspaceId: input.workspaceId,
          },
          baseRev: 0,
          ops: batch,
          replaces: [],
          intent: "Refresh bounded git co-change edges",
        },
        signal,
      );
      if (!["Ok", "Idempotent"].includes(result.status))
        throw new Error(`History patch was not applied (${result.status})`);
      graphChanged ||= result.status !== "Idempotent";
      rev = Math.max(rev ?? 0, result.rev);
    }
    state.patchId = attempt;
  }
  state.index = index;
  state.workspaceId = input.workspaceId;
  state.edgeIds = [...edgeIds];
  // Cursor and query index move together, after the graph acknowledged the write.
  saveHistory(input.root, state);
  rmSync(pendingPath, { force: true });
  return {
    mined: state.mined,
    edges: index.edges.length,
    symbolFiles: state.symbolFiles,
    symbolSkipped: state.symbolSkipped,
    graphChanged,
    rev,
  };
}
