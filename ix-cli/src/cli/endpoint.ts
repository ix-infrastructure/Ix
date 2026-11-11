// Copyright 2026 Ix Infrastructure Inc.

/**
 * The one answer to "is this endpoint this machine?".
 *
 * It used to be answered in five places with five rules: the token rule, the
 * reset path, the unreachable hint, auto-start and the stitch lock each had
 * their own host list, and they disagreed (`http://[::1]:8090` was sent the
 * token but reset as a remote; `http://127.0.0.2:8090` was sent the token but
 * got the remote hint). Every caller now asks this module. Keep it free of
 * imports so the client layer can use it without pulling in the CLI.
 */

/** Where the CLI looks for a backend when nothing says otherwise; what `ix docker start` serves. */
export const DEFAULT_ENDPOINT = "http://localhost:8090";

/** The port the standalone compose (`ix docker start`) publishes. */
const MANAGED_PORT = new URL(DEFAULT_ENDPOINT).port;

/**
 * True when the endpoint is served from this machine (loopback).
 *
 * This is the rule that decides whether the bearer token is sent, so it must
 * never get wider. A URL that does not parse is NOT local.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    // A trailing dot is the fully-qualified form and resolvers accept it.
    const host = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "");
    return (
      host === "localhost" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || // 127.0.0.0/8, as an ADDRESS
      // ...not a prefix: `127.0.0.1.evil.com` is a remote name that starts "127."
      host === "0.0.0.0" ||
      host === "[::1]" // new URL() always brackets IPv6, so bare "::1" is unreachable
    );
  } catch {
    return false;
  }
}

/**
 * True when the endpoint is the backend `ix docker start` brings up: loopback
 * AND the managed port. For any other endpoint -- a remote, or a second local
 * backend on another port -- that command starts containers the CLI then never
 * talks to, so neither auto-start nor the hints may suggest it.
 */
export function isManagedLocalBackend(endpoint: string): boolean {
  if (!isLoopbackEndpoint(endpoint)) return false;
  try {
    return new URL(endpoint).port === MANAGED_PORT;
  } catch {
    return false;
  }
}

/**
 * Host names (as `URL.hostname` and a port-stripped `Host` header spell them)
 * that the `ix view` server accepts from a browser.
 *
 * Deliberately a subset of what `isLoopbackEndpoint` accepts. That predicate
 * answers "where do I send a request"; this list guards INBOUND requests
 * against DNS rebinding and cross-site calls (a web page can address
 * `0.0.0.0` to reach this machine). Widening it would loosen a security check,
 * so it keeps the names it always accepted.
 */
export const BROWSER_LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
