import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

import type { IxClient } from "../client/api.js";
import type { HealthResponse } from "../client/types.js";

/**
 * Everything that reads or writes `~/.ix/.backend-version`.
 *
 * A leaf on purpose. `upgrade.ts` owns the update notice and imports
 * `backend-status.ts`, so the stamp could not live in either without a cycle the
 * moment `backend-status` needed to write it. Keeping it here lets the ONE
 * function that fetches health also record what it read, which is what stops a
 * future call site from silently forgetting to.
 */

const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");

/** The release the backend is believed to be running. */
export const BACKEND_VERSION_FILE = join(IX_HOME, ".backend-version");

/**
 * The one definition of a valid version string, imported by upgrade.ts too.
 *
 * Copied rather than shared once already, and this exact pattern has shipped
 * broken: written as a single `(?:[-+]...)?` group whose class omitted `+`, it
 * rejected the valid tag `0.9.0-rc.1+abc1234` and `ix upgrade` exited 1 with
 * "Could not reach GitHub" against a perfectly reachable GitHub. Two copies mean
 * the next correction lands in one of them.
 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Longer than any plausible tag; bounds a value the container controls. */
const MAX_VERSION_LENGTH = 64;

export function getTrackedVersion(versionFile: string): string {
  try {
    if (!existsSync(versionFile)) return "0.0.0";
    return readFileSync(versionFile, "utf-8").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Record a version stamp. Returns whether it was written.
 *
 * `mkdirSync` because IX_HOME may not exist yet. A falsy version is refused: not
 * knowing which release we are on is not the same as being on none of them.
 *
 * NOT atomic, deliberately. `writeFileSync` opens with O_TRUNC, so a reader
 * landing mid-write sees "" and is told a current backend is out of date — and
 * this is now reachable from `ix status`/`ix map` while `checkForUpdate` reads
 * the file on every command. Two things make that the better trade anyway:
 * `recordBackendRelease` short-circuits when the stamp already agrees, so a
 * write happens only when the backend's version actually CHANGES, not per
 * command; and a temp-file-plus-rename replaces a file the caller may not have
 * permission to write, since rename needs the directory rather than the file.
 * That would silently change when the stamp-failure warning fires and would
 * force the tests that pin it onto read-only directories, which Windows does not
 * honour. Worth revisiting with an injection that works on both platforms.
 */
export function writeVersionStamp(
  versionFile: string,
  version: string | null | undefined,
): boolean {
  if (!version) return false;
  try {
    mkdirSync(dirname(versionFile), { recursive: true });
    writeFileSync(versionFile, version);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record what the backend says it is running.
 *
 * `.backend-version` was a record of what the CLI last INSTALLED, which is the
 * same thing as what is RUNNING only while nothing else moves the image. Pull
 * through docker compose and the file names an older release than the container,
 * so the update notice fires on every command for ever. The container is the one
 * thing that always knows, so it is asked rather than inferred.
 *
 * Three things bound a value the container controls, because this file decides
 * whether the user is ever told about an upgrade again:
 *
 * - it is trimmed before matching. `getTrackedVersion` trims on the way out, and
 *   JavaScript's `$` does not match before a trailing newline, so without this a
 *   value from an --env-file or a ConfigMap silently fails the shape test and
 *   the whole feature no-ops with nothing to see.
 * - it must be version-shaped and bounded in length. It is an env var an
 *   operator can set to anything.
 * - it may NOT claim to be newer than the newest release we know of. Otherwise
 *   one container reporting `99.0.0` — a typo in a compose override, or a
 *   tampered image — permanently silences the notice AND makes `ix upgrade`
 *   report "already on the latest version" without ever pulling, so a security
 *   release can never reach that machine. When no release is known yet, only
 *   corrections that do not move the stamp forward are accepted, which still
 *   repairs a stamp stuck ahead and defers the rest until the cache exists.
 */
export function recordBackendRelease(
  reported: string | null | undefined,
  knownLatest: string | null | undefined,
  isNewer: (a: string, b: string) => boolean,
): boolean {
  const value = typeof reported === "string" ? reported.trim() : "";
  if (!value || value.length > MAX_VERSION_LENGTH || !VERSION_RE.test(value)) return false;

  const tracked = getTrackedVersion(BACKEND_VERSION_FILE);
  if (value === tracked) return false; // already agrees; do not touch the file

  const ceiling =
    typeof knownLatest === "string" && VERSION_RE.test(knownLatest.trim())
      ? knownLatest.trim()
      : null;
  // No published release can be older than what a container legitimately runs.
  if (ceiling ? isNewer(value, ceiling) : isNewer(value, tracked)) return false;

  return writeVersionStamp(BACKEND_VERSION_FILE, value);
}

/**
 * True when this endpoint is the local backend the update notice is about.
 *
 * The stamp is global (`~/.ix/.backend-version`) but the endpoint is per
 * invocation, so `IX_ENDPOINT=http://staging:8090 ix status` would otherwise
 * record a different deployment's release into the file that governs the LOCAL
 * docker image notice — a newer remote silencing a genuinely stale local
 * backend, or an older one nagging about a current one.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    // A trailing dot is the fully-qualified form and resolvers accept it.
    const host = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "");
    return (
      host === "localhost" ||
      host.startsWith("127.") || // all of 127.0.0.0/8 is loopback
      host === "0.0.0.0" || // what client/api.ts and errors.ts already accept
      host === "[::1]" // new URL() always brackets IPv6, so bare "::1" is unreachable
    );
  } catch {
    return false;
  }
}

/**
 * Fetch `/v1/health` AND record the release it reports.
 *
 * The single place either happens. Every command that wants health goes through
 * here, so "a new call site forgot to record" is not a mistake that can be made
 * — which is worth more than the grep-based drift guard it replaces.
 */
export async function fetchBackendHealth(
  client: IxClient,
  knownLatest: string | null | undefined,
  isNewer: (a: string, b: string) => boolean,
): Promise<HealthResponse> {
  const health = await client.health();
  // From the client the request actually went to. Taking it as a second
  // argument reintroduced exactly the "a call site can get it wrong" mistake
  // this module exists to make impossible.
  if (isLocalEndpoint(client.endpoint)) {
    recordBackendRelease(health.release_version, knownLatest, isNewer);
  }
  return health;
}
