import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const statsCalls = { n: 0 };

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async stats() {
      statsCalls.n += 1;
      return { nodes: { total: 10 }, edges: { total: 20 } };
    }
    async conflicts() { return []; }
    async health() { return { status: "ok" }; }
  },
}));

vi.mock("../backend-version.js", async (orig) => ({
  ...(await orig<typeof import("../backend-version.js")>()),
  fetchBackendHealth: async () => ({ status: "ok", schema_version: 3 }),
}));

let savedEndpoint: string | undefined;

beforeEach(() => {
  vi.resetModules();
  statsCalls.n = 0;
  // Doctor runs checks this test does not mock (the live-container inspection,
  // the schema probe). Point them at a closed port so they fail fast and
  // locally instead of reaching whatever backend happens to be up: a test that
  // silently depends on a running backend is green on CI and red on a dev box.
  savedEndpoint = process.env.IX_ENDPOINT;
  process.env.IX_ENDPOINT = "http://127.0.0.1:9";
});

afterEach(() => {
  if (savedEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = savedEndpoint;
});

async function runDoctor(): Promise<void> {
  const { registerDoctorCommand } = await import("../commands/doctor.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerDoctorCommand(program);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await program.parseAsync(["doctor", "--format", "llm"], { from: "user" });
  } catch { /* exitOverride / process.exit path */ } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("ix doctor", () => {
  /**
   * "Graph has nodes" and "Graph has edges" are two questions about one
   * response, and they were two `client.stats()` calls run back to back by the
   * sequential check loop. `/v1/stats` is 3-4s on a large graph, so the second
   * one was roughly half of what `ix doctor` spent.
   */
  it("asks the backend for stats once, not once per check that reads it", async () => {
    await runDoctor();
    expect(statsCalls.n).toBe(1);
  });
});
