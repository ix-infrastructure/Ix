// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../api.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("search probe cancellation", () => {
  it("cancels the fetch and does not send the signal in the wire body", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = new IxClient().search("sample", { signal: controller.signal, nameOnly: true, limit: 10 });
    const rejection = expect(pending).rejects.toBeDefined();
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init.body))).toEqual({ term: "sample", limit: 10, nameOnly: true });
    controller.abort();
    await rejection;
    expect(init.signal!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send an already-cancelled probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(new IxClient().search("sample", { signal: controller.signal })).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never retries an optional probe even when ordinary read retries are enabled", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new IxClient(undefined, undefined, { retryReads: true }).search("sample", {
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation independent from an identical shared ordinary read", async () => {
    let completeRead!: (response: Response) => void;
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (fetchMock.mock.calls.length === 1) completeRead = resolve;
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new IxClient(undefined, undefined, { shareReads: true, maxInFlight: 1 });
    const ordinary = client.search("sample");
    // Let the ordinary read enter its limiter before starting the probe.
    await Promise.resolve();
    const controller = new AbortController();
    const probe = client.search("sample", { signal: controller.signal });
    const rejectedProbe = expect(probe).rejects.toBeDefined();
    controller.abort();
    await rejectedProbe;
    completeRead(new Response("[]", { status: 200 }));
    expect(await ordinary).toEqual([]);
    expect(await client.search("sample")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.sharedReadHits).toBe(1);
  });
});
