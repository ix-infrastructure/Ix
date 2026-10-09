// Copyright 2026 Ix Infrastructure Inc.

import { getEndpoint, getLocalToken } from "../cli/config.js";
import { IxClient } from "./api.js";
import { QUERY_CLIENT_OPTIONS } from "./request-memo.js";
import { combineSignals, currentRunSignal } from "./run-signal.js";

export interface CreateClientOptions {
  /** Backend URL. Defaults to `getEndpoint()` (IX_ENDPOINT, then config.yaml). */
  endpoint?: string;
  /** Aborts every request this client makes once it fires (a whole-command deadline). */
  deadlineSignal?: AbortSignal;
  /**
   * A read-heavy, single-command client: repeated reads are answered from the
   * first response and requests in flight are capped (`QUERY_CLIENT_OPTIONS`).
   */
  query?: boolean;
  /**
   * No read deadline: the command's reads may rightly take longer (`stats` on
   * a large graph, `map` and `ingest`, whose reads can come minutes in), or
   * the client is not one command's (`@ix/pro`'s). A caller that passes its
   * own `deadlineSignal` gets none either: it has already chosen its bound.
   * `map` and `ingest` say so explicitly, because their deadline can be off
   * (`IX_MAP_DEADLINE_MS=0`, and `ix ingest` passes none).
   */
  longRunning?: boolean;
}

/** The default whole-command bound on reads; `IX_READ_DEADLINE_MS` overrides it, 0 turns it off. */
export const DEFAULT_READ_DEADLINE_MS = 60_000;

/** At most this many requests in flight per client, for every command. */
export const DEFAULT_MAX_IN_FLIGHT = 12;

export function readDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IX_READ_DEADLINE_MS?.trim();
  if (!raw) return DEFAULT_READ_DEADLINE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_READ_DEADLINE_MS;
}

/**
 * The one place an `IxClient` is built. Every command gets its client here, so
 * anything that must apply to every request (an auth token, an abort signal, a
 * limiter, a deadline) is added once. An ESLint rule forbids `new IxClient(`
 * outside `src/client/` and tests.
 */
export function createClient(opts: CreateClientOptions = {}): IxClient {
  const endpoint = opts.endpoint ?? getEndpoint();
  const token = getLocalToken(endpoint);
  return new IxClient(
    endpoint,
    // Under `ix mcp`, the tool call's own deadline as well: its timeout aborts
    // this client's requests instead of leaving them open (see run-signal.ts).
    combineSignals(opts.deadlineSignal, currentRunSignal()),
    {
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      retryReads: true,
      readDeadlineMs: opts.longRunning || opts.deadlineSignal ? 0 : readDeadlineMs(),
      ...(opts.query ? QUERY_CLIENT_OPTIONS : {}),
      ...(token ? { token } : {}),
    },
  );
}
