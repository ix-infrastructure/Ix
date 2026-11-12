// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";

// The backend is down, and this is the default local endpoint, where a CLI
// run would start Docker. Inside `ix mcp` it must not.
vi.mock("../commands/upgrade.js", () => ({
  readBackendHealth: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }),
}));
const execFileSync = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

const saved = { IX_ENDPOINT: process.env.IX_ENDPOINT };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  execFileSync.mockReset();
});

describe("ensureBackendAvailable under ix mcp", () => {
  it("reports backend_unreachable instead of starting Docker", async () => {
    process.env.IX_ENDPOINT = "http://localhost:8090";
    const { ensureBackendAvailable } = await import("../bootstrap.js");
    const { withCaller } = await import("../next-step.js");
    const { mcpCaller } = await import("../../mcp/hints.js");
    await expect(withCaller(mcpCaller(), () => ensureBackendAvailable())).rejects.toThrow(/backend_unreachable/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
