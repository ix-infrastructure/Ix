// Copyright 2026 Ix Infrastructure Inc.

// The cloud ingest path is not the bulk commit path, and the transient-status
// retry added for bulk commits (IN-19C, commit-retry.ts) must never reach it.
// `ix map` hands a cloud-ready workspace to the registered RemoteRunner in one
// call. A long cloud upload that fails, even with a 502/503/504/429 and a
// `Retry-After`, is reported once and never sent again from here, and nothing
// on that path goes through a commit route.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpError, IxClient } from "../../client/api.js";
import { registerMapCommand } from "../commands/map.js";
import { registerRemoteRunner, type RemoteIngestOptions } from "../remote.js";

describe("ix map on the cloud path", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ["IX_LOCK_DIR", "IX_ENDPOINT", "IX_HOME", "IX_AUTO_MAP", "IX_MAP_DEADLINE_MS"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ix-map-cloud-"));
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.IX_LOCK_DIR = path.join(dir, "locks");
    fs.mkdirSync(process.env.IX_LOCK_DIR);
    process.env.IX_HOME = path.join(dir, "home");
    // Nothing here may reach a real backend: a stray request fails fast.
    process.env.IX_ENDPOINT = "http://127.0.0.1:9";
    delete process.env.IX_AUTO_MAP;
    delete process.env.IX_MAP_DEADLINE_MS;
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // No unregister: a runner that is never ready routes everything local again.
    registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => false });
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["a gateway timeout", () => httpError(504, "<html>Gateway Timeout</html>", new Headers())],
    ["a 503 asking to retry at once", () => httpError(503, '{"error":"unavailable"}', new Headers({ "Retry-After": "0" }))],
    ["a 429 asking to retry", () => httpError(429, '{"error":"slow down"}', new Headers({ "Retry-After": "1" }))],
  ])("sends a failed cloud upload once, after %s, and never through a commit route", async (_label, failure) => {
    const root = path.join(dir, "workspace");
    fs.mkdirSync(root);
    const calls: RemoteIngestOptions[] = [];
    registerRemoteRunner({
      isReady: async () => true,
      runIngestion: async opts => {
        calls.push(opts);
        throw failure();
      },
    });
    const bulk = vi.spyOn(IxClient.prototype, "commitPatchBulk");
    const single = vi.spyOn(IxClient.prototype, "commitPatch");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerMapCommand(program);
    await program.parseAsync(["node", "ix", "map", root, "--silent"]);

    expect(calls, "one upload, no re-send").toHaveLength(1);
    // `ix map` uploads the canonical root (realpath): /var -> /private/var on
    // macOS, 8.3 short names expanded on Windows.
    expect(calls[0]).toMatchObject({ cwd: fs.realpathSync.native(root) });
    expect(bulk).not.toHaveBeenCalled();
    expect(single).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
