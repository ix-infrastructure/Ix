// Copyright 2026 Ix Infrastructure Inc.

/**
 * Checks the API reference (docs/api/openapi.yaml) against a real backend, at
 * least for existence: one request per documented method + path, and a
 * failure for every one the backend does not route. check-api-parity.mjs only
 * compares the reference with the client, so a client call the backend no
 * longer serves stayed documented as live until this check.
 *
 * Pure parts only (which requests to send, how to read the answer), so the
 * unit suite can test them without a backend. api-reference.e2e.ts sends them.
 */

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Fills every `{name}` path slot. No such id exists, so lookups answer their
 * own not-found. The nil UUID, because a route that matches its id as a UUID
 * (`/v1/reset/status/{opId}`, for one) would reject any other string before
 * the handler and answer like an unknown path; a plain string segment matches
 * it too.
 */
export const PROBE_ID = "00000000-0000-0000-0000-000000000000";

/** A path no backend serves: its answer is what "no such route" looks like on this backend. */
export const UNKNOWN_ROUTE = "/v1/__ix_route_probe_missing__";

export interface Probe {
  method: HttpMethod;
  /** As documented, e.g. `/v1/entity/{id}`. */
  path: string;
  /** Path and query actually requested, e.g. `/v1/entity/00000000-0000-0000-0000-000000000000`. */
  url: string;
  /** JSON body for methods that carry one. */
  body?: string;
}

interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string };
}

function sampleValue(p: Parameter): string {
  switch (p.schema?.type) {
    case "integer":
    case "number":
      return "1";
    case "boolean":
      return "false";
    default:
      return PROBE_ID;
  }
}

/** One probe per documented method + path, in document order. */
export function buildProbes(doc: { paths?: Record<string, Record<string, unknown>> }): Probe[] {
  const probes: Probe[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = (item.parameters as Parameter[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method] as { parameters?: Parameter[] } | undefined;
      if (!op) continue;
      const query = [...shared, ...(op.parameters ?? [])]
        .filter((p) => p.in === "query" && p.required && p.name)
        .map((p) => `${encodeURIComponent(p.name!)}=${encodeURIComponent(sampleValue(p))}`);
      const url = path.replace(/\{[^}]+\}/g, PROBE_ID) + (query.length ? `?${query.join("&")}` : "");
      probes.push({ method, path, url, ...(method === "post" || method === "put" || method === "patch" ? { body: "{}" } : {}) });
    }
  }
  return probes;
}

export interface ProbeAnswer {
  status: number;
  body: string;
}

/**
 * The request path is blanked out of a body before bodies are compared, so a
 * "no route for <path>" message from the backend matches the baseline's.
 */
export function normalizeBody(body: string, url: string): string {
  const path = url.split("?")[0];
  return body.split(path).join("<path>").trim();
}

/**
 * Why the backend does not serve this probe's route, or null when it does.
 *
 * 405 always means the method is not served. A 404 is ambiguous: it is also a
 * handler's own "no such entity / op / session", which every `{id}` probe
 * gets. Such a 404 counts as served when its body differs from the answer to
 * an unknown route (`unknownRoute`, the same method sent to UNKNOWN_ROUTE). A
 * 404 that looks exactly like the unknown-route answer did not reach a
 * handler.
 */
export function missingRoute(probe: Probe, answer: ProbeAnswer, unknownRoute: ProbeAnswer): string | null {
  const label = `${probe.method.toUpperCase()} ${probe.path}`;
  const detail = () => `${answer.status} ${answer.body.trim().slice(0, 200)}`;
  if (answer.status === 405) return `${label}: method not allowed (${detail()})`;
  if (answer.status !== 404) return null;
  const same =
    unknownRoute.status === 404 &&
    normalizeBody(answer.body, probe.url) === normalizeBody(unknownRoute.body, UNKNOWN_ROUTE);
  return same ? `${label}: not routed, answers like an unknown path (${detail()})` : null;
}

/**
 * The op id of an async operation this answer started, or null. Both 200 and
 * 202 count: the client sees 202 from `POST /v1/reset/code/async`, the
 * reference documents 200, and either way the work may still be running.
 */
export function startedOpId(answer: ProbeAnswer): string | null {
  if (answer.status !== 200 && answer.status !== 202) return null;
  try {
    const opId = (JSON.parse(answer.body) as { opId?: unknown } | null)?.opId;
    return typeof opId === "string" && opId.length > 0 ? opId : null;
  } catch {
    return null;
  }
}
