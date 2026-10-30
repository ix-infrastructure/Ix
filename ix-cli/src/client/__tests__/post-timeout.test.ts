// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../api.js";

afterEach(() => { vi.unstubAllGlobals(); });

/** A fetch that never answers and rejects when its signal aborts. */
function stalledFetch() {
  return vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
}

describe("per-request timeouts on POST reads", () => {
  it("degree() aborts at its own timeoutMs rather than the 2-minute default", async () => {
    const fetchMock = stalledFetch();
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(new IxClient().degree(["a"], { direction: "in", timeoutMs: 20 })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchMock.mock.calls[0][1].signal!.aborted).toBe(true);
  });

  it("runSmells() aborts at its own timeoutMs rather than the 2-minute default", async () => {
    const fetchMock = stalledFetch();
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(new IxClient().runSmells({ timeoutMs: 20 })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/smells");
  });
});
