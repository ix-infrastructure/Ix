// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IxClient } from "../client/api.js";
import { mapResultCachePath } from "./config.js";
import { isRev } from "./ingest-baseline.js";

/**
 * The last `/v1/map` response for a project root, reused by an `ix map` that
 * ingested nothing.
 *
 * `ix map` runs after every agent response (the plugins' Stop hooks), and on
 * a large repo the map request is most of its cost: 4.2 s of 5.7 s on a
 * 30k-file repo where nothing had changed. The backend memoises a scoped map
 * per revision, but still answers slowly, so the only way to skip the cost is
 * to not ask.
 *
 * The response is reused only when every input that decides it is unchanged:
 *
 *   - the graph, by the backend's head revision. Every committed patch in any
 *     workspace advances it, so this is stricter than the map needs, never
 *     laxer: a commit elsewhere costs one extra request, not a stale map.
 *   - the request itself (workspace, `full`), the endpoint, the backend's
 *     release and schema, and this CLI's version.
 *
 * And, decided by the caller, only when this run's ingest wrote nothing
 * (`IngestFilesSummary.graphUnchanged`). The revision alone would miss a
 * workspace whose data was deleted without a commit, which the ingest's
 * DB-reset guard catches.
 *
 * The revision is the backend's GLOBAL head because that is the only one it
 * serves (`/v1/revisions/current`; see docs/api/openapi.yaml). A write in any
 * workspace therefore invalidates every workspace's slot. Once the backend
 * serves a workspace-local revision (audit F-18), the slot should key on that
 * instead; until then no client code asks for one.
 *
 * After an incremental edit, `ix map` does not ask at all: it defers the map
 * and prints the last stored response (`loadLastMap`, `map-freshness.ts`).
 *
 * Only a workspace-scoped map is cached. A system-scoped one can change
 * without a commit: the stitcher writes cross-repo edges and stamps system
 * ids directly. So does the unscoped global map, which persists regions as a
 * commit of its own. Both always ask the backend.
 */

/** Everything besides the graph that decides what `/v1/map` answers. */
export interface MapCacheSlot {
  /** Request body, endpoint, backend release/schema and CLI version, as one string. */
  key: string;
  /** The backend's head revision when the slot was resolved. */
  revision: string;
}

/** The parts of a `/v1/map` response `ix map` renders. Nothing else is stored. */
export interface CachedMapResponse {
  file_count: number;
  region_count: number;
  levels: number;
  map_rev: number;
  outcome?: string;
  regions: any[];
}

interface SerializedMapCache {
  root: string;
  key: string;
  revision: string;
  result: CachedMapResponse;
}

let cachedCliVersion: string | undefined;

function cliVersion(): string {
  if (cachedCliVersion !== undefined) return cachedCliVersion;
  let version = "unknown";
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "../../package.json"), "utf-8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch { /* "unknown": still a key, just a coarser one */ }
  cachedCliVersion = version;
  return version;
}

/**
 * A stable string for the backend's head revision, or undefined when the body
 * is not one.
 *
 * `/v1/revisions/current` answers with the head's revision record when the
 * backend has one and with the bare number when it does not. The record's
 * patch id and timestamp are kept beside the number, so a graph that was
 * reset and has since counted back up to the same revision does not match.
 */
export function revisionToken(body: unknown): string | undefined {
  if (isRev(body)) return JSON.stringify([body]);
  if (body === null || typeof body !== "object") return undefined;
  const record = body as { rev?: unknown; patchId?: unknown; timestamp?: unknown };
  if (!isRev(record.rev)) return undefined;
  const patchId = typeof record.patchId === "string" ? record.patchId : null;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  return JSON.stringify([record.rev, patchId, timestamp]);
}

/**
 * The release and schema the backend reports, or undefined when it reports
 * neither -- a backend that cannot say what it is cannot be told apart from
 * the next one, so its maps are not cached.
 */
export function backendIdentity(health: unknown): string | undefined {
  if (health === null || typeof health !== "object") return undefined;
  const h = health as { release_version?: unknown; version?: unknown; schema_version?: unknown };
  const release = typeof h.release_version === "string" ? h.release_version
    : typeof h.version === "string" ? h.version
    : undefined;
  const schema = typeof h.schema_version === "number" ? h.schema_version : undefined;
  if (release === undefined && schema === undefined) return undefined;
  return JSON.stringify([release ?? null, schema ?? null]);
}

/**
 * The slot this map reads and writes, or undefined when it must ask the
 * backend and not keep the answer.
 *
 * Two cheap reads -- health and the head revision -- and any failure of
 * either means "not cacheable", never an error: the map request that follows
 * reports a backend problem better than this would. Health is read through
 * the caller's reader, so it goes through the one place health bodies are
 * read and recorded (`readBackendHealth`).
 */
export async function resolveMapCacheSlot(
  client: Pick<IxClient, "endpoint" | "currentRevision">,
  request: { full?: boolean; workspaceId?: string; systemId?: string },
  readHealth: () => Promise<unknown>,
): Promise<MapCacheSlot | undefined> {
  if (request.full || request.systemId || !request.workspaceId) return undefined;
  try {
    const [health, head] = await Promise.all([readHealth(), client.currentRevision()]);
    const backend = backendIdentity(health);
    const revision = revisionToken(head);
    if (backend === undefined || revision === undefined) return undefined;
    const key = JSON.stringify({
      request: { full: false, workspace_id: request.workspaceId },
      endpoint: client.endpoint,
      backend,
      cli: cliVersion(),
    });
    return { key, revision };
  } catch {
    return undefined;
  }
}

function isCachedMapResponse(value: unknown): value is CachedMapResponse {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.file_count === "number"
    && typeof r.region_count === "number"
    && typeof r.levels === "number"
    && typeof r.map_rev === "number"
    && (r.outcome === undefined || typeof r.outcome === "string")
    && Array.isArray(r.regions);
}

/** The response stored for this slot, or undefined when there is none that matches. */
export function loadCachedMap(projectRoot: string, slot: MapCacheSlot): CachedMapResponse | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(mapResultCachePath(projectRoot), "utf-8")) as Partial<SerializedMapCache>;
    if (data.root !== projectRoot || data.key !== slot.key || data.revision !== slot.revision) return undefined;
    return isCachedMapResponse(data.result) ? data.result : undefined;
  } catch {
    return undefined;
  }
}

/** Store a response for this slot. Best-effort: a cache that cannot be written is not an error. */
export function saveCachedMap(projectRoot: string, slot: MapCacheSlot, result: CachedMapResponse): void {
  const data: SerializedMapCache = {
    root: projectRoot,
    key: slot.key,
    revision: slot.revision,
    result: {
      file_count: result.file_count,
      region_count: result.region_count,
      levels: result.levels,
      map_rev: result.map_rev,
      outcome: result.outcome,
      regions: result.regions,
    },
  };
  const target = mapResultCachePath(projectRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Via a temp file and rename, so a reader never sees half a file.
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* non-critical */ }
  }
}

/**
 * The last response stored for this root and request key, whatever revision
 * it was computed at -- what a deferred `ix map` prints (CL-13). Deliberately
 * blind to the revision: the caller has just ingested an edit and knows the
 * regions are behind, and marks them so. Used only on that deferral path;
 * everything else reads `loadCachedMap`.
 */
export function loadLastMap(projectRoot: string, key: string): CachedMapResponse | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(mapResultCachePath(projectRoot), "utf-8")) as Partial<SerializedMapCache>;
    if (data.root !== projectRoot || data.key !== key) return undefined;
    return isCachedMapResponse(data.result) ? data.result : undefined;
  } catch {
    return undefined;
  }
}
