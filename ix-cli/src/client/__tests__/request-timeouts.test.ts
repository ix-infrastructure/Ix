// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../api.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("POST request timeouts", () => {
  it.each(["degree", "smells"] as const)("aborts %s within its requested timeout", async (method) => {
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new IxClient();
    const pending = method === "degree"
      ? client.degree(["node"], { direction: "both", timeoutMs: 20 })
      : client.runSmells({ timeoutMs: 20 });

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/v1/${method}`);
    expect(init.signal!.aborted).toBe(true);
    expect(JSON.parse(String(init.body))).not.toHaveProperty("timeoutMs");
  }, 1000);
});
