// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which backend the CLI talks to (`getEndpoint`) and the bearer token it may
 * send there. The client factory (`client/factory.ts`) imports this module and
 * nothing else from `cli/` but the import-free `endpoint.ts`, so keep it free
 * of workspace selection, state paths and the HTTP client. Split out of
 * `config.ts` (#943); `config.ts` re-exports everything here.
 */

import { randomBytes } from "node:crypto";
import { isLoopbackEndpoint } from "./endpoint.js";
import { loadConfig, updateConfig, type IxConfig } from "./config-store.js";

export function getEndpoint(): string {
  return process.env.IX_ENDPOINT || loadConfig().endpoint;
}

/**
 * The bearer token the client sends to `endpoint`, if any: IX_TOKEN, else the
 * stored `auth.local_token`.
 *
 * Either goes only to a loopback endpoint. The token is the local backend's
 * (`ix docker` runs it on this machine), so pointing IX_ENDPOINT at another
 * host must not hand that host the credential. And a remote backend has its
 * own auth: Ix Pro's cloud wrapper adds the org's JWT only to a request that
 * carries no Authorization header, so a bearer set here would replace it.
 */
export function getLocalToken(endpoint: string = getEndpoint()): string | undefined {
  if (!isLoopbackEndpoint(endpoint)) return undefined;
  const explicit = process.env.IX_TOKEN?.trim();
  if (explicit) return explicit;
  return storedLocalToken();
}

/** The token in config.yaml's `auth.local_token`, if one is stored. */
export function storedLocalToken(): string | undefined {
  const stored = loadConfig().auth?.local_token;
  return typeof stored === "string" && stored.trim() ? stored.trim() : undefined;
}

/**
 * The stored local token, saved first if there is none: `preferred` when given
 * (a token the user already set by hand in ~/.ix/backend/.env), else a new one
 * (32 random bytes, hex). Only `ix docker start --local-token` calls this: the
 * token is opt-in until a release turns it on by default.
 */
export function ensureLocalToken(preferred?: string): string {
  const existing = storedLocalToken();
  if (existing) return existing;
  return updateConfig((config) => {
    const stored = config.auth?.local_token;
    if (typeof stored === "string" && stored.trim()) return { result: stored.trim() };
    const token = preferred?.trim() || randomBytes(32).toString("hex");
    return { save: { ...config, auth: { ...config.auth, local_token: token } }, result: token };
  });
}

/** Forget the stored local token. */
export function clearLocalToken(): void {
  updateConfig((config) => {
    if (!config.auth?.local_token) return { result: undefined };
    const { local_token: _dropped, ...rest } = config.auth;
    const next: IxConfig = { ...config };
    if (Object.keys(rest).length > 0) next.auth = rest;
    else delete next.auth;
    return { save: next, result: undefined };
  });
}
