import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  CLIENT_EXPECTED_SCHEMA_VERSION,
  checkBackendSchema,
  isNonStandardBackend,
  type BackendContainer,
} from "../backend-status.js";
import type { IxClient } from "../../client/api.js";

function fakeClient(health: () => Promise<any>): IxClient {
  return { health } as unknown as IxClient;
}

function container(overrides: Partial<BackendContainer>): BackendContainer {
  return {
    containerId: "abc123",
    imageRef: "ghcr.io/ix-infrastructure/ix-memory-layer:latest",
    imageId: "sha256:deadbeef",
    repoDigests: [],
    composeProject: "ix",
    composeConfigFiles: null,
    ...overrides,
  };
}

describe("checkBackendSchema", () => {
  it("matches when the backend reports the expected version", async () => {
    const s = await checkBackendSchema(fakeClient(async () => ({ status: "ok", schema_version: CLIENT_EXPECTED_SCHEMA_VERSION })));
    expect(s).toEqual({ reachable: true, serverVersion: CLIENT_EXPECTED_SCHEMA_VERSION, expected: CLIENT_EXPECTED_SCHEMA_VERSION, matches: true });
  });

  it("flags a mismatch when the persisted graph predates the engine", async () => {
    const s = await checkBackendSchema(fakeClient(async () => ({ status: "ok", schema_version: CLIENT_EXPECTED_SCHEMA_VERSION - 1 })));
    expect(s.matches).toBe(false);
    expect(s.serverVersion).toBe(CLIENT_EXPECTED_SCHEMA_VERSION - 1);
  });

  it("does not flag when the backend reports no schema version (can't prove stale)", async () => {
    const s = await checkBackendSchema(fakeClient(async () => ({ status: "ok" })));
    expect(s.matches).toBe(true);
    expect(s.serverVersion).toBeNull();
  });

  it("reports unreachable (and does not flag) when health throws", async () => {
    const s = await checkBackendSchema(fakeClient(async () => { throw new Error("ECONNREFUSED"); }));
    expect(s).toEqual({ reachable: false, serverVersion: null, expected: CLIENT_EXPECTED_SCHEMA_VERSION, matches: true });
  });
});

describe("isNonStandardBackend", () => {
  const standard = join(homedir(), ".ix", "backend", "docker-compose.yml");

  it("treats a compose project under ~/.ix/backend as standard", () => {
    expect(isNonStandardBackend(container({ composeConfigFiles: standard }))).toBe(false);
  });

  it("flags a compose project outside ~/.ix/backend", () => {
    expect(isNonStandardBackend(container({ composeConfigFiles: "/work/ix-memory-layer/docker-compose.yml" }))).toBe(true);
  });

  it("does not flag when no compose config files are known", () => {
    expect(isNonStandardBackend(container({ composeConfigFiles: null }))).toBe(false);
  });
});
