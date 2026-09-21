// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isRepairInvocation } from "../register/pro-failure.js";

const argv = (...args: string[]) => ["/node", "/ix", ...args];

describe("repair invocations after an installed Pro fails to initialize", () => {
  it.each(["upgrade", "status", "docker", "help", "--help", "-h", "--version", "-V"])(
    "lets %s through so the install can be repaired or reported",
    (name) => expect(isRepairInvocation(argv(name))).toBe(true),
  );

  // The guard exists for these: anything that reaches the graph or the cloud
  // must not run while Pro's credential guard is known to be broken.
  it.each(["reset", "search", "map", "ingest", "plan", "decide", "login", "connect"])(
    "still stops %s",
    (name) => expect(isRepairInvocation(argv(name))).toBe(false),
  );

  it("stops a bare ix rather than printing help over the failure", () => {
    expect(isRepairInvocation(argv())).toBe(false);
  });

  it("reads the command, not a flag that happens to precede it", () => {
    expect(isRepairInvocation(argv("reset", "--help"))).toBe(false);
  });
});

describe("detectPro", () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock("../register/pro-loader.js"); });

  it("resolves false — never a cached rejection — for a broken installed Pro", async () => {
    vi.resetModules();
    const loader = vi.fn(async () => { throw new Error("Installed Ix Pro could not initialize"); });
    vi.doMock("../register/pro-loader.js", () => ({ tryLoadProCommands: loader }));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    const { detectPro } = await import("../../mcp/runner.js");

    // Every later caller — `ix mcp doctor`, the server's own startup — shares
    // the memoized promise. A cached rejection would take all of them down.
    await expect(detectPro()).resolves.toBe(false);
    await expect(detectPro()).resolves.toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join("")).toContain("failed to initialize");
    stderr.mockRestore();
  });

  it("still reports a genuinely absent Pro as false without warning", async () => {
    vi.resetModules();
    vi.doMock("../register/pro-loader.js", () => ({ tryLoadProCommands: async () => false }));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    const { detectPro } = await import("../../mcp/runner.js");

    await expect(detectPro()).resolves.toBe(false);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });
});
