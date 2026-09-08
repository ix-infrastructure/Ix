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

import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IxClient } from "../client/api.js";
import { fetchBackendHealth } from "./backend-version.js";

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

function inspectContainer(containerId: string): BackendContainer | null {
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

function containerIds(output: string | null): string[] {
  return output?.split("\n").map((id) => id.trim()).filter(Boolean) ?? [];
}

function isReleasedBackendRef(imageRef: string): boolean {
  return imageRef === BACKEND_IMAGE ||
    imageRef.startsWith(`${BACKEND_IMAGE}:`) ||
    imageRef.startsWith(`${BACKEND_IMAGE}@`);
}

/** Inspect the backend reached through the container publishing its port. */
export function inspectBackendContainer(): BackendContainer | null {
  const publisherIds = containerIds(
    docker(["ps", "--filter", `publish=${BACKEND_PORT}`, "--format", "{{.ID}}"]),
  );
  if (publisherIds.length === 0) return null;

  const publishers = publisherIds
    .map((id) => inspectContainer(id))
    .filter((container): container is BackendContainer => container !== null);
  const directBackend = publishers.find((container) => isReleasedBackendRef(container.imageRef));
  if (directBackend) return directBackend;

  // A hardened compose may publish 8090 through nginx while the memory layer
  // stays on an internal network. Follow the publisher's compose project to
  // the service whose role is the backend instead of comparing nginx to GHCR.
  for (const publisher of publishers) {
    if (!publisher.composeProject) continue;
    const backendIds = containerIds(docker([
      "ps",
      "--filter", `label=com.docker.compose.project=${publisher.composeProject}`,
      "--filter", "label=com.docker.compose.service=memory-layer",
      "--format", "{{.ID}}",
    ]));
    for (const id of backendIds) {
      const backend = inspectContainer(id);
      if (backend) return backend;
    }
  }

  // Preserve local-development detection for a directly-published backend
  // whose image does not use the released repository name.
  return publishers[0] ?? null;
}

/**
 * A container in the backend stack that is down, with whatever it said on the
 * way out.
 *
 * Exists because a fatal Arango boot loop is invisible from the CLI: the
 * failure is inside a container that keeps restarting, so every command --
 * `ix doctor` included -- sees nothing but a backend that will not answer, and
 * "backend not started" is indistinguishable from "backend cannot start and
 * never will". Ix#614.
 */
export interface StackFailure {
  /** Compose service name where known, else the image reference. */
  service: string;
  containerId: string;
  /** Docker's own state string: `restarting`, `exited`, ... */
  state: string;
  /** The most recent fatal-looking log line, trimmed. */
  lastError: string | null;
  /** Set only for a failure whose remedy we actually know. */
  remedy: string | null;
}

/** `docker logs` with stdout and stderr merged; "" on any failure. */
function dockerLogsMerged(containerId: string, tail = "80"): string {
  const r = spawnSync("docker", ["logs", "--tail", tail, containerId], {
    encoding: "utf-8",
    timeout: 10000,
  });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

/** Last line that looks like a hard failure, searching newest-first. */
function lastFatalLine(logs: string): string | null {
  const lines = logs.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\bFATAL\b|\bunable to initialize\b|\bInvalid argument\b/i.test(lines[i]!)) return lines[i]!;
  }
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

/**
 * Recognise failures whose fix is known, so the user gets an instruction and
 * not just a transcript.
 */
function remedyFor(line: string | null): string | null {
  if (!line) return null;
  if (/Column families not opened:\s*VectorIndex/i.test(line)) {
    // One-way door: the column family is in the RocksDB MANIFEST for good, so
    // the only non-destructive fix is to keep registering it. Ix#614.
    return "ArangoDB's data directory has the VectorIndex column family, so arangod must be started with it enabled. " +
      "Add `--vector-index true` to the arangodb `command:` in ~/.ix/backend/docker-compose.yml, then `ix docker restart`. " +
      "(The option is spelled `--experimental-vector-index` before ArangoDB 3.12.11.) No data is lost.";
  }
  return null;
}

/**
 * Look for a container in the backend stack that is not running.
 *
 * Deliberately image-based rather than compose-label-based: the label is absent
 * for a hand-run container, and this is called precisely when the stack is in a
 * state nobody planned. Returns the highest-ranked non-running Arango -- an
 * actively restarting, compose-managed one first, since that is what holds
 * memory-layer's `service_healthy` gate shut.
 */
export function diagnoseBackendStack(): StackFailure | null {
  const SEP = "|::|";
  const listed = docker(["ps", "-a", "--format", `{{.ID}}${SEP}{{.Image}}${SEP}{{.State}}${SEP}{{.Label "com.docker.compose.service"}}`]);
  if (!listed) return null;

  // Rank before picking. A boot LOOP presents as `restarting`, and that is the
  // one holding memory-layer's `service_healthy` gate shut; a long-dead
  // `exited` container from an old experiment is the likeliest false positive,
  // and reporting its error as the current outage would be worse than saying
  // nothing. A compose-managed container outranks a hand-run one for the same
  // reason.
  const rank = (state: string, service: string): number =>
    (state === "restarting" ? 0 : 2) + (service ? 0 : 1);

  const candidates = listed.split("\n")
    .map((row) => {
      const [id = "", image = "", state = "", service = ""] = row.split(SEP);
      return { id, image, state, service };
    })
    .filter((c) => c.id && /arangodb/i.test(c.image) && c.state !== "running")
    .sort((a, b) => rank(a.state, a.service) - rank(b.state, b.service));

  for (const { id, image, state, service } of candidates) {
    // --tail keeps this bounded; a boot loop can produce a very large log.
    // Both streams: `docker logs` keeps the container's stdout/stderr apart,
    // and which one carries the fatal line is the container's choice, not
    // ours. The arangodb image logs it on stdout; a config that sends it to
    // stderr would otherwise make this whole diagnostic silently find nothing.
    const logs = dockerLogsMerged(id);
    const lastError = lastFatalLine(logs);
    return {
      service: service || image,
      containerId: id,
      state: state || "unknown",
      lastError,
      remedy: remedyFor(lastError),
    };
  }
  return null;
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

/**
 * Read the backend's reported schema_version and compare to what we expect.
 *
 * Also RECORDS the release the backend reports, as a side effect of going
 * through the shared health fetch — the same as every other health call site.
 */
export async function checkBackendSchema(
  client: IxClient,
  // REQUIRED, not defaulted. Defaults of `null` + `() => false` turn off the
  // ceiling AND the no-ceiling fallback at once, so a caller that omitted them
  // would record any version-shaped claim a local container made — the exact
  // 99.0.0 case recordBackendRelease exists to refuse. This is a published
  // export, so "a call site can get it wrong" has to be impossible, not
  // discouraged.
  knownLatest: string | null,
  isNewer: (a: string, b: string) => boolean,
): Promise<BackendSchemaStatus> {
  const expected = CLIENT_EXPECTED_SCHEMA_VERSION;
  try {
    // Through the chokepoint, so this records like every other health fetch —
    // there is no cycle: backend-version.ts imports only node builtins and two
    // erased `import type`s.
    const health = await fetchBackendHealth(client, knownLatest, isNewer);
    const serverVersion = typeof health.schema_version === "number" ? health.schema_version : null;
    // No reported version (older backend) is treated as a match: we can't prove
    // staleness, and the ingest path already forces a re-ingest when it can.
    const matches = serverVersion === null || serverVersion === expected;
    return { reachable: true, serverVersion, expected, matches };
  } catch {
    return { reachable: false, serverVersion: null, expected, matches: true };
  }
}
