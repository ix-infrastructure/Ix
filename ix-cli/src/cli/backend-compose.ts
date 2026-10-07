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

/**
 * `.env` with IX_LOCAL_TOKEN set to `token` (empty: the backend does not
 * require one). Other lines a user added are kept.
 */
export function backendEnvContents(existing: string, token: string | undefined): string {
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !/^\s*(export\s+)?IX_LOCAL_TOKEN\s*=/.test(line));
  return [...kept, `IX_LOCAL_TOKEN=${token ?? ""}`].join("\n") + "\n";
}

/**
 * Write ~/.ix/backend/.env for the stored token, atomically and at mode 0600:
 * it holds the credential. Compose reads it for `${IX_LOCAL_TOKEN}`.
 */
export function writeBackendEnv(token: string | undefined, envFile: string = backendEnvFile()): void {
  let existing = "";
  try { existing = readFileSync(envFile, "utf-8"); } catch { /* none yet */ }
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.${process.pid}.tmp`;
  writeFileSync(tmp, backendEnvContents(existing, token), { mode: 0o600 });
  try {
    renameSync(tmp, envFile);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  try { chmodSync(envFile, 0o600); } catch { /* the create mode is the primary guard */ }
}

/**
 * The `docker compose` arguments that name the backend's files: the env file
 * (rewritten from the stored token first, so a token change reaches the next
 * `up`) and the user's override file when there is one.
 */
export function backendComposeArgs(composeFile: string): string[] {
  const envFile = backendEnvFile();
  writeBackendEnv(storedLocalToken(), envFile);
  const args = ["compose", "--env-file", envFile, "-f", composeFile];
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
