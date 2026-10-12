// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";
import { createDatabaseProbe, probeDatabase, type DatabaseVerdict } from "../database-probe.js";
import { httpError, LocalTokenRequiredError } from "../../client/api.js";
import type { HealthResponse } from "../../client/types.js";

/** A client whose health and revision reads answer as told. */
function client(health: () => Promise<HealthResponse>, revision: () => Promise<unknown> = async () => 1) {
  return { health: vi.fn(health), currentRevision: vi.fn(revision) };
}

describe("probeDatabase", () => {
  it("is unreachable on the 503 degraded answer of a 1.0.33+ backend", async () => {
    const c = client(async () => { throw httpError(503, '{"status":"degraded","database":"unreachable"}'); });
    expect(await probeDatabase(c)).toBe("unreachable");
    expect(c.currentRevision).not.toHaveBeenCalled();
  });

  it("is unreachable on a 200 that reports the database unreachable", async () => {
    expect(await probeDatabase(client(async () => ({ status: "ok", database: "unreachable" })))).toBe("unreachable");
  });

  it("is reachable when health says so, without a second request", async () => {
    const c = client(async () => ({ status: "ok", database: "reachable" }));
    expect(await probeDatabase(c)).toBe("reachable");
    expect(c.currentRevision).not.toHaveBeenCalled();
  });

  it("passes its short timeout to both requests", async () => {
    const c = client(async () => ({ status: "ok" }));
    await probeDatabase(c, { timeoutMs: 1234 });
    expect(c.health).toHaveBeenCalledWith(1234);
    expect(c.currentRevision).toHaveBeenCalledWith(1234);
  });

  describe("on a backend whose health does not report the database", () => {
    const old = (revision: () => Promise<unknown>) => client(async () => ({ status: "ok" }), revision);

    it("is reachable when the current revision reads", async () => {
      expect(await probeDatabase(old(async () => ({ rev: 4 })))).toBe("reachable");
    });

    it("is unknown when that read fails with a 5xx (not proof of a database outage)", async () => {
      expect(await probeDatabase(old(async () => { throw httpError(500, '{"error":"arango down"}'); }))).toBe("unknown");
    });

    it("is unknown when the read is refused for the token, times out, is a 4xx, or never connects", async () => {
      const failures: unknown[] = [
        new LocalTokenRequiredError('{"code":"local_token_required"}'),
        new DOMException("The operation timed out", "TimeoutError"),
        httpError(404, '{"error":"not found"}'),
        new TypeError("fetch failed"),
      ];
      for (const failure of failures) {
        expect(await probeDatabase(old(async () => { throw failure; })), String(failure)).toBe("unknown");
      }
    });
  });

  it("is unknown when health itself fails, times out or is refused", async () => {
    const failures: unknown[] = [
      new TypeError("fetch failed"),
      new DOMException("The operation timed out", "TimeoutError"),
      new LocalTokenRequiredError('{"code":"local_token_required"}'),
      httpError(503, "<html>bad gateway</html>"),
    ];
    for (const failure of failures) {
      const c = client(async () => { throw failure; });
      expect(await probeDatabase(c), String(failure)).toBe("unknown");
      expect(c.currentRevision).not.toHaveBeenCalled();
    }
  });
});

describe("createDatabaseProbe", () => {
  it("asks once for everyone in flight, and reuses the answer for the interval", async () => {
    let clock = 0;
    let release: (v: DatabaseVerdict) => void = () => {};
    const ask = vi.fn(() => new Promise<DatabaseVerdict>(resolve => { release = resolve; }));
    const probe = createDatabaseProbe(ask, 3_000, () => clock);

    const a = probe();
    const b = probe();
    release("unreachable");
    expect(await a).toBe("unreachable");
    expect(await b).toBe("unreachable");
    expect(ask).toHaveBeenCalledTimes(1);

    clock = 2_999;
    expect(await probe()).toBe("unreachable");
    expect(ask).toHaveBeenCalledTimes(1);

    clock = 3_000;
    const c = probe();
    release("reachable");
    expect(await c).toBe("reachable");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("turns a probe that throws into unknown", async () => {
    const probe = createDatabaseProbe(async () => { throw new Error("boom"); });
    expect(await probe()).toBe("unknown");
  });
});
