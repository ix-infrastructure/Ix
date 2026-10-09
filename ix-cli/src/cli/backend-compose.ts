// Copyright 2026 Ix Infrastructure Inc.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storedLocalToken } from "./config.js";
import { ixHome } from "./ix-home.js";

/**
 * The files `docker compose` is given for the backend in ~/.ix/backend, shared
 * by `ix docker` and `ix upgrade` so both start the same stack.
 */

/** Compose variables for the backend (IX_LOCAL_TOKEN). Mode 0600: it holds the credential. */
export function backendEnvFile(): string {
  return join(ixHome(), "backend", ".env");
}

/**
 * The user's own additions to the backend compose, applied when present. The
 * shipped compose does not publish ArangoDB's port; a user who wants its web
 * UI publishes it here (see docs/prerequisites.md).
 */
export function backendOverrideFile(): string {
  return join(ixHome(), "backend", "docker-compose.override.yml");
}

const LOCAL_TOKEN_LINE = /^\s*(?:export\s+)?IX_LOCAL_TOKEN\s*=(.*)$/;
const LOCAL_TOKEN_IN_FILE = /^\s*(?:export\s+)?IX_LOCAL_TOKEN\s*=/m;

/**
 * The IX_LOCAL_TOKEN a `.env` sets, if any: the last assignment, as Compose
 * reads it, with surrounding quotes removed. An empty value is no token.
 */
export function envFileLocalToken(existing: string): string | undefined {
  let value: string | undefined;
  for (const line of existing.split(/\r?\n/)) {
    const m = LOCAL_TOKEN_LINE.exec(line);
    if (m) value = dotenvValue(m[1]);
  }
  return value ? value : undefined;
}

/**
 * A dotenv value the way Docker Compose reads it: a quoted value ends at its
 * closing quote (anything after, such as ` # note`, is ignored); an unquoted
 * one ends where whitespace starts a ` #` comment.
 */
function dotenvValue(raw: string): string {
  const v = raw.trim();
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const close = v.indexOf(quote, 1);
    if (close > 0) return v.slice(1, close).trim();
  }
  return v.replace(/\s+#.*$/, "").trim();
}

/**
 * `.env` with IX_LOCAL_TOKEN set to `token` (empty: the backend does not
 * require one). Every other line a user wrote, comments and blank lines
 * included, is kept where it was; the token line replaces the first existing
 * one, or is appended.
 */
export function backendEnvContents(existing: string, token: string | undefined): string {
  const tokenLine = `IX_LOCAL_TOKEN=${token ?? ""}`;
  const lines = existing === "" ? [] : existing.replace(/\r?\n$/, "").split(/\r?\n/);
  const out: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (LOCAL_TOKEN_LINE.test(line)) {
      if (!placed) out.push(tokenLine);
      placed = true;
    } else {
      out.push(line);
    }
  }
  if (!placed) out.push(tokenLine);
  return out.join("\n") + "\n";
}

function readEnvFile(envFile: string): string {
  try { return readFileSync(envFile, "utf-8"); } catch { return ""; }
}

/**
 * Write ~/.ix/backend/.env for `token`, atomically and at mode 0600: it holds
 * the credential. Compose reads it for `${IX_LOCAL_TOKEN}`. A file that already
 * says the same is left untouched.
 */
export function writeBackendEnv(token: string | undefined, envFile: string = backendEnvFile()): void {
  const existing = readEnvFile(envFile);
  // Already says the same (however the user quoted it): leave the file as it is.
  if (existsSync(envFile) && envFileLocalToken(existing) === (token || undefined) && LOCAL_TOKEN_IN_FILE.test(existing)) {
    // Nothing to rewrite, but the file still holds a credential: keep it 0600.
    try { chmodSync(envFile, 0o600); } catch { /* best effort */ }
    return;
  }
  const next = backendEnvContents(existing, token);
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  try {
    renameSync(tmp, envFile);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  try { chmodSync(envFile, 0o600); } catch { /* the create mode is the primary guard */ }
}

/**
 * The token the backend should be started with: the stored one when there is
 * one (it is what this CLI sends, so the two must agree), else whatever the
 * user set by hand in `.env`, which `ix docker start` has no reason to erase.
 * `clear` (`--no-local-token`) drops a hand-set token too: the user asked for
 * no token at all.
 */
export function backendStartToken(
  stored: string | undefined,
  existing: string,
  clear = false,
): string | undefined {
  if (stored) return stored;
  return clear ? undefined : envFileLocalToken(existing);
}

/** The IX_LOCAL_TOKEN set by hand in ~/.ix/backend/.env, if any. */
export function handSetLocalToken(envFile: string = backendEnvFile()): string | undefined {
  return envFileLocalToken(readEnvFile(envFile));
}

export interface BackendComposeOptions {
  /**
   * Rewrite `.env` from the stored token first, so a token change reaches the
   * container. Only commands that (re)create the backend (`up`) need this;
   * read-only ones (`ps`, `logs`) and `stop`/`restart` must not touch the file.
   */
  writeEnv?: boolean;
  /** With `writeEnv`: drop a hand-set token as well (`--no-local-token`). */
  clearToken?: boolean;
}

/**
 * The `docker compose` arguments that name the backend's files: the env file
 * (written first only when `writeEnv` asks; passed only when it exists, since
 * Compose refuses a missing `--env-file`) and the user's override file when
 * there is one.
 */
export function backendComposeArgs(composeFile: string, opts: BackendComposeOptions = {}): string[] {
  const envFile = backendEnvFile();
  if (opts.writeEnv) {
    writeBackendEnv(backendStartToken(storedLocalToken(), readEnvFile(envFile), opts.clearToken), envFile);
  }
  const args = ["compose"];
  if (existsSync(envFile)) args.push("--env-file", envFile);
  args.push("-f", composeFile);
  const override = backendOverrideFile();
  if (existsSync(override)) args.push("-f", override);
  return args;
}

/** Whether a compose file passes IX_LOCAL_TOKEN to the backend (older ones do not). */
export function composeSupportsLocalToken(composeText: string): boolean {
  return /\$\{IX_LOCAL_TOKEN\b/.test(composeText);
}

/**
 * The arangodb service's health from `docker compose ps --format json`, which
 * prints one JSON object per line on current Compose and a JSON array on older
 * releases. "absent" when this compose project runs no arangodb container.
 */
export function parseArangoHealth(psOutput: string): "healthy" | "unhealthy" | "starting" | "absent" {
  const text = psOutput.trim();
  if (!text) return "absent";
  let rows: Array<{ Service?: string; Health?: string; State?: string }>;
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = text.split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const arango = rows.find((r) => r.Service === "arangodb");
  if (!arango) return "absent";
  if (arango.Health === "healthy") return "healthy";
  if (arango.Health === "starting") return "starting";
  return "unhealthy";
}
