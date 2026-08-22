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

// Doctor also inspects the live container and probes the schema. Both are
// mocked, not merely pointed somewhere harmless: an unmocked `docker inspect`
// or socket connect is slow-and-variable rather than fast-and-failing, which is
// how this test timed out at 5s on the Windows runner while passing on Linux.
vi.mock("../backend-status.js", async (orig) => ({
  ...(await orig<typeof import("../backend-status.js")>()),
  checkBackendImage: () => ({ kind: "docker-unavailable" as const }),
  checkBackendSchema: async () => ({ ok: true as const }),
  isNonStandardBackend: () => false,
}));

vi.mock("../commands/upgrade.js", async (orig) => ({
  ...(await orig<typeof import("../commands/upgrade.js")>()),
  readBackendHealth: async () => ({ status: "ok", schema_version: 3 }),
}));

let savedEndpoint: string | undefined;

beforeEach(() => {
  vi.resetModules();
  statsCalls.n = 0;
  // Belt and braces with the mocks above: nothing in this test may depend on a
  // backend being reachable, or on how quickly a given OS refuses a connection.
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
