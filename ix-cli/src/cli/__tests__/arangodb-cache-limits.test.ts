// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { backendEnvContents, writeBackendEnv } from "../backend-compose.js";

/**
 * ArangoDB sizes its caches from the host's RAM, so on a developer laptop the
 * shipped backend held a large share of it for a small graph. The shipped
 * compose file caps the caches (not the process), each cap overridable from
 * ~/.ix/backend/.env.
 */

const REPO_COMPOSE = resolve(fileURLToPath(new URL("../../../../docker-compose.standalone.yml", import.meta.url)));

interface Service {
  image?: string;
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  [key: string]: unknown;
}
const text = readFileSync(REPO_COMPOSE, "utf8");
const compose = parse(text) as { services: Record<string, Service>; volumes: Record<string, unknown> };
const arango = compose.services.arangodb;
const command = arango.command ?? [];

const CAPS = [
  { flag: "--rocksdb.block-cache-size", variable: "IX_ARANGO_BLOCK_CACHE_SIZE", value: "536870912" },
  { flag: "--rocksdb.enforce-block-cache-size-limit", variable: "IX_ARANGO_ENFORCE_BLOCK_CACHE_LIMIT", value: "true" },
  { flag: "--rocksdb.total-write-buffer-size", variable: "IX_ARANGO_WRITE_BUFFER_SIZE", value: "268435456" },
  { flag: "--cache.size", variable: "IX_ARANGO_CACHE_SIZE", value: "134217728" },
];

describe("docker-compose.standalone.yml: ArangoDB cache caps", () => {
  it("keeps the existing arangod arguments first and unchanged", () => {
    expect(command.slice(0, 5)).toEqual(["arangod", "--server.endpoint", "tcp://0.0.0.0:8529", "--vector-index", "true"]);
  });

  it.each(CAPS)("sets $flag from $variable, defaulting to $value", ({ flag, variable, value }) => {
    const entries = command.filter((arg) => arg.startsWith(`${flag}=`));
    expect(entries).toEqual([`${flag}=\${${variable}:-${value}}`]);
  });

  it("passes nothing else to arangod", () => {
    expect(command).toHaveLength(5 + CAPS.length);
  });

  it("caps caches only: no container memory limit, query memory limit or detected-memory override", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service, name).not.toHaveProperty("mem_limit");
      expect(service, name).not.toHaveProperty("memswap_limit");
      expect(service, name).not.toHaveProperty("mem_reservation");
      expect(service, name).not.toHaveProperty("deploy");
      expect(JSON.stringify(service.environment ?? {}), name).not.toMatch(/ARANGODB_OVERRIDE_DETECTED_TOTAL_MEMORY|Xmx|JAVA_/);
    }
    expect(command.join(" ")).not.toMatch(/--query\.(global-)?memory-limit/);
  });

  it("keeps the image, the data volume and the service names", () => {
    expect(Object.keys(compose.services)).toEqual(["arangodb", "memory-layer"]);
    expect(arango.image).toBe("arangodb:3.12.11");
    expect(arango.volumes).toEqual(["arangodb-data:/var/lib/arangodb3"]);
    expect(Object.keys(compose.volumes)).toEqual(["arangodb-data"]);
    expect(arango.environment).toEqual({ ARANGO_NO_AUTH: "1" });
  });
});

describe("~/.ix/backend/.env keeps the IX_ARANGO_* overrides", () => {
  let t: string;
  beforeEach(() => { t = mkdtempSync(join(tmpdir(), "ix-arango-env-")); });
  afterEach(() => { rmSync(t, { recursive: true, force: true }); });

  it("rewriting the token leaves a user's cache override in place", () => {
    const envFile = join(t, ".env");
    writeFileSync(envFile, "# bigger cache for a big monorepo\nIX_ARANGO_BLOCK_CACHE_SIZE=2147483648\nIX_LOCAL_TOKEN=\n");
    writeBackendEnv("a".repeat(64), envFile);
    expect(readFileSync(envFile, "utf8")).toBe(
      `# bigger cache for a big monorepo\nIX_ARANGO_BLOCK_CACHE_SIZE=2147483648\nIX_LOCAL_TOKEN=${"a".repeat(64)}\n`);
    writeBackendEnv(undefined, envFile);
    expect(readFileSync(envFile, "utf8")).toContain("IX_ARANGO_BLOCK_CACHE_SIZE=2147483648\n");
  });

  it("appends the token after an override-only .env", () => {
    expect(backendEnvContents("IX_ARANGO_CACHE_SIZE=268435456\n", undefined))
      .toBe("IX_ARANGO_CACHE_SIZE=268435456\nIX_LOCAL_TOKEN=\n");
  });
});
