// Backend freshness helpers (Ix#270, Ix#271).
//
// Two distinct staleness problems can make a healthy-looking backend serve
// wrong/empty results:
//   1. The running CONTAINER is not the released image (a local dev build, or an
//      older digest), yet `ix upgrade` thinks it is current because it trusts the
//      ~/.ix/.backend-version stamp instead of the running image (Ix#270).
//   2. The persisted GRAPH predates the running engine's on-disk format, so
//      scoped reads silently return empty until the user re-maps (Ix#271).
//
// This module inspects the actual running container and compares the backend's
// reported schema_version against what this CLI expects, so `ix doctor` and
// `ix upgrade` can surface both instead of looking mysteriously broken.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IxClient } from "../client/api.js";

export const BACKEND_IMAGE = "ghcr.io/ix-infrastructure/ix-memory-layer";
const BACKEND_PORT = "8090";
const IX_HOME = process.env.IX_HOME || join(homedir(), ".ix");
const STANDARD_BACKEND_DIR = join(IX_HOME, "backend");

// On-disk graph format this CLI expects. MUST stay in sync with the backend's
// reported schema_version; a mismatch forces a full re-ingest (see ingest.ts,
// which imports this constant). Bump when the node-identity/format changes.
export const CLIENT_EXPECTED_SCHEMA_VERSION = 3;

function docker(args: string[], timeout = 10000): string | null {
  try {
    return execFileSync("docker", args, { encoding: "utf-8", timeout }).trim();
  } catch {
    return null;
  }
}

export function dockerAvailable(): boolean {
  return docker(["info"]) !== null;
}

export interface BackendContainer {
  containerId: string;
  /** Image reference the container was created from (e.g. ghcr.io/...:latest). */
  imageRef: string;
  /** Resolved image content id (sha256:...) the container is actually running. */
  imageId: string;
  /** Registry digests of that image; empty for a never-pushed local build. */
  repoDigests: string[];
  composeProject: string | null;
  composeConfigFiles: string | null;
}

/** Inspect the container currently publishing the backend port, if any. */
export function inspectBackendContainer(): BackendContainer | null {
  const ids = docker(["ps", "--filter", `publish=${BACKEND_PORT}`, "--format", "{{.ID}}"]);
  if (!ids) return null;
  const containerId = ids.split("\n")[0]?.trim();
  if (!containerId) return null;

  // A unique separator keeps Go-template parsing robust against odd image refs.
  const SEP = "|::|";
  const fmt =
    `{{.Image}}${SEP}{{.Config.Image}}` +
    `${SEP}{{index .Config.Labels "com.docker.compose.project"}}` +
    `${SEP}{{index .Config.Labels "com.docker.compose.project.config_files"}}`;
  const inspected = docker(["inspect", containerId, "--format", fmt]);
  if (!inspected) return null;
  const [imageId = "", imageRef = "", project = "", configFiles = ""] = inspected.split(SEP);

  let repoDigests: string[] = [];
  const digestsJson = docker(["image", "inspect", imageId || imageRef, "--format", "{{json .RepoDigests}}"]);
  if (digestsJson) {
    try {
      const parsed = JSON.parse(digestsJson);
      if (Array.isArray(parsed)) repoDigests = parsed;
    } catch {
      /* leave empty */
    }
  }

  return {
    containerId,
    imageRef,
    imageId,
    repoDigests,
    composeProject: project || null,
    composeConfigFiles: configFiles || null,
  };
}

export type BackendImageStatus =
  | { kind: "ok"; container: BackendContainer }
  | { kind: "local-build"; container: BackendContainer }
  | { kind: "digest-mismatch"; container: BackendContainer; latestImageId: string }
  | { kind: "latest-not-pulled"; container: BackendContainer }
  | { kind: "not-running" }
  | { kind: "docker-unavailable" };

/**
 * Compare the running backend container against the locally-pulled released
 * `:latest` image. Conclusions only when we can prove a mismatch; an
 * inconclusive state (latest not pulled, docker down) never reports a problem.
 */
export function checkBackendImage(): BackendImageStatus {
  if (!dockerAvailable()) return { kind: "docker-unavailable" };
  const container = inspectBackendContainer();
  if (!container) return { kind: "not-running" };

  const latestImageId = docker(["image", "inspect", `${BACKEND_IMAGE}:latest`, "--format", "{{.Id}}"]);
  if (!latestImageId) return { kind: "latest-not-pulled", container };

  if (container.imageId === latestImageId) return { kind: "ok", container };

  // Different from the released image. A container with no registry digests (or
  // one not built from the released repo) is a local build; otherwise it is an
  // older/divergent pulled digest.
  const isReleasedRepo = container.repoDigests.some((d) => d.startsWith(BACKEND_IMAGE + "@"));
  if (container.repoDigests.length === 0 || !isReleasedRepo) {
    return { kind: "local-build", container };
  }
  return { kind: "digest-mismatch", container, latestImageId };
}

/** True when the running backend uses a compose project outside ~/.ix/backend. */
export function isNonStandardBackend(container: BackendContainer): boolean {
  const cfg = container.composeConfigFiles;
  if (!cfg) return false;
  return !cfg.split(",").some((p) => p.trim().startsWith(STANDARD_BACKEND_DIR));
}

export interface BackendSchemaStatus {
  reachable: boolean;
  serverVersion: number | null;
  expected: number;
  matches: boolean;
}

/** Read the backend's reported schema_version and compare to what we expect. */
export async function checkBackendSchema(client: IxClient): Promise<BackendSchemaStatus> {
  const expected = CLIENT_EXPECTED_SCHEMA_VERSION;
  try {
    const health = await client.health();
    const serverVersion = typeof health.schema_version === "number" ? health.schema_version : null;
    // No reported version (older backend) is treated as a match: we can't prove
    // staleness, and the ingest path already forces a re-ingest when it can.
    const matches = serverVersion === null || serverVersion === expected;
    return { reachable: true, serverVersion, expected, matches };
  } catch {
    return { reachable: false, serverVersion: null, expected, matches: true };
  }
}
