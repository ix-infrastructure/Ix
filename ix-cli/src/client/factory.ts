// Copyright 2026 Ix Infrastructure Inc.

import { getEndpoint } from "../cli/config.js";
import { IxClient } from "./api.js";
import { QUERY_CLIENT_OPTIONS } from "./request-memo.js";

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
}

/**
 * The one place an `IxClient` is built. Every command gets its client here, so
 * anything that must apply to every request (an auth token, an abort signal, a
 * limiter, a deadline) is added once. An ESLint rule forbids `new IxClient(`
 * outside `src/client/` and tests.
 */
export function createClient(opts: CreateClientOptions = {}): IxClient {
  return new IxClient(
    opts.endpoint ?? getEndpoint(),
    opts.deadlineSignal,
    opts.query ? QUERY_CLIENT_OPTIONS : {},
  );
}
