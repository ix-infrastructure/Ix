// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IxClient } from "../api.js";
import { isBackendUnreachable } from "../../cli/errors.js";

const opId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const response = (body: unknown, status = 200) => Response.json(body, { status });
const accepted = () => response({ opId }, 202);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function mockRequests(...results: (Response | Error)[]) {
  const requests: { url: string; method: string }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" });
    const next = results.shift();
    if (!next) throw new Error("Unexpected additional request");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return requests;
}

describe("remote reset outcome", () => {
  it.each(["reset", "resetCode"] as const)("keeps %s polling the same UUID until confirmed done", async method => {
    vi.useFakeTimers();
    const requests = mockRequests(accepted(), response({ opId, state: "running" }), response({ opId, state: "done" }));
    const result = new IxClient("https://synthetic.example")[method]();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(requests.map(r => r.method)).toEqual(["POST", "GET", "GET"]);
    expect(requests[1].url).toBe(`https://synthetic.example/v1/reset/status/${opId}`);
    expect(requests[2].url).toBe(requests[1].url);
  });

  it.each([
    ["lost status", () => response({}, 404)],
    ["denied status", () => response({}, 403)],
    ["unavailable status", () => response({}, 503)],
    ["transport failure", () => new Error("synthetic transport loss")],
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["wrong operation", () => response({ opId: foreignId, state: "done" })],
    ["missing operation", () => response({ state: "done" })],
    ["invalid state", () => response({ opId, state: "unrecognized" })],
    ["invalid state type", () => response({ opId, state: ["done"] })],
    ["partial failure", () => response({ opId, state: "failed", error: "pipeline operation requires reconciliation" })],
  ] as const)("requires reconciliation after %s without sending another reset", async (_label, statusResult) => {
    const requests = mockRequests(accepted(), statusResult());
    const result = new IxClient("https://synthetic.example").resetCode();
    await expect(result).rejects.toThrow(opId);
    await expect(result).rejects.toThrow("Do not repeat the reset until an administrator has reconciled");
    await expect(result).rejects.not.toThrow("re-run the command");
    expect(requests.map(r => r.method)).toEqual(["POST", "GET"]);
  });

  it.each([
    ["unavailable start", () => new Error("synthetic response loss")],
    ["unexpected 200", () => response({ opId })],
    ["malformed acknowledgment", () => new Response("{", { status: 202 })],
    ["null acknowledgment", () => response(null, 202)],
    ["missing operation ID", () => response({}, 202)],
    ["injected path", () => response({ opId: "../another-tenant" }, 202)],
  ] as const)("does not poll or fall back after %s", async (_label, beginResult) => {
    const requests = mockRequests(beginResult());
    await expect(new IxClient("https://synthetic.example").reset()).rejects.toThrow("Do not repeat the reset");
    expect(requests.map(r => r.method)).toEqual(["POST"]);
  });

  it("does not interpret rejected starts as an unsupported endpoint", async () => {
    const requests = mockRequests(response({ error: "verified_tenant_required" }, 401));
    await expect(new IxClient("https://synthetic.example").reset()).rejects.toThrow("401");
    expect(requests).toHaveLength(1);
  });

  it("preserves synchronous fallback only when the async start route is absent", async () => {
    const requests = mockRequests(response({}, 404), response({ ok: true, message: "Graph reset." }));
    await expect(new IxClient("https://synthetic.example").reset()).resolves.toMatchObject({ ok: true });
    expect(requests.map(r => r.url)).toEqual([
      "https://synthetic.example/v1/reset/async", "https://synthetic.example/v1/reset"]);
  });

  it("leaves local synchronous behavior unchanged", async () => {
    const requests = mockRequests(response({ ok: true, message: "Graph reset." }));
    await expect(new IxClient("http://127.0.0.1:8090").resetCode()).resolves.toMatchObject({ ok: true });
    expect(requests).toEqual([{ url: "http://127.0.0.1:8090/v1/reset/code", method: "POST" }]);
  });

  it("requires reconciliation at the polling deadline without another reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const running = response({ opId, state: "running" });
    vi.spyOn(running, "json").mockImplementation(async () => {
      vi.setSystemTime(900001);
      return { opId, state: "running" };
    });
    const requests = mockRequests(accepted(), running);
    const failure = expect(new IxClient("https://synthetic.example").reset())
      .rejects.toThrow("Completion was not confirmed");
    await vi.advanceTimersByTimeAsync(2000);
    await failure;
    expect(requests.map(r => r.method)).toEqual(["POST", "GET"]);
  });

  // undici reports the real code one level down, under a "fetch failed" wrapper.
  const coded = (code: string, nested = false) => {
    const inner = Object.assign(new Error(code), { code });
    return nested ? Object.assign(new TypeError("fetch failed"), { cause: inner }) : inner;
  };

  it.each([
    ["a refused connection", "ECONNREFUSED", false],
    ["an unresolved host", "ENOTFOUND", false],
    ["a refused connection wrapped by undici", "ECONNREFUSED", true],
  ] as const)("reports %s as unreachable rather than possible data loss", async (_l, code, nested) => {
    const requests = mockRequests(coded(code, nested));
    const result = new IxClient("https://synthetic.example").reset();
    // The request never left the machine, so nothing was deleted. Surfacing
    // the transport error lets renderCliError say "start the backend".
    await expect(result).rejects.not.toThrow("Do not repeat the reset");
    await expect(result).rejects.toMatchObject(nested ? { cause: { code } } : { code });
    expect(requests.map(r => r.method)).toEqual(["POST"]);
  });

  it("still requires reconciliation when an established socket closes at start", async () => {
    // UND_ERR_SOCKET counts as unreachable for error RENDERING but not here:
    // the socket was established, so the reset may have been transmitted.
    const requests = mockRequests(coded("UND_ERR_SOCKET"));
    await expect(new IxClient("https://synthetic.example").reset())
      .rejects.toThrow("Do not repeat the reset");
    expect(requests).toHaveLength(1);
  });

  // Regression guard: attaching `cause` put a transport code one level below an
  // error whose OWN message is the thing that must be read. Without the marker,
  // renderCliError classified these by that cause and printed "start the
  // backend, then check status" — telling the user to retry the reset.
  it.each(["UND_ERR_SOCKET", "ECONNREFUSED"])(
    "renders the do-not-repeat warning, not retry advice, when the cause is %s",
    async (code) => {
      const transport = coded(code);
      mockRequests(accepted(), transport);
      const failure = await new IxClient("https://synthetic.example").reset().catch((e) => e);
      expect(isBackendUnreachable(failure)).toBe(false);
      expect(failure.message).toContain("Do not repeat the reset");
    });

  it("keeps reconciliation for a lost status poll and preserves the cause", async () => {
    // Asymmetric with the start call on purpose: by now the reset is accepted
    // (202) and running server-side, so why the poll failed does not matter.
    const transport = coded("ECONNREFUSED");
    mockRequests(accepted(), transport);
    const result = new IxClient("https://synthetic.example").resetCode();
    await expect(result).rejects.toThrow("Do not repeat the reset");
    await expect(result).rejects.toMatchObject({ cause: transport });
  });
});
