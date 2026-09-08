import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Ix#614: a fatal Arango boot loop is invisible from the CLI. The container
 * restarts forever, memory-layer never leaves `Created` behind
 * `service_healthy`, and `ix doctor` reports only that the backend is
 * unreachable — the same thing it says when nothing was started at all.
 *
 * These pin the classification, not docker. The log lines are verbatim from a
 * real 3.12.11 container booted against a volume carrying the VectorIndex
 * column family.
 */
const FATAL_VECTOR_INDEX =
  "2026-09-08T18:35:45.330761Z [1-1] FATAL [fe3df] {startup} unable to initialize " +
  "RocksDB engine: Invalid argument: Column families not opened: VectorIndex";

const SEP = "|::|";

function mockDocker(handler: (args: string[]) => string) {
  vi.doMock("node:child_process", () => ({
    execFileSync: (_cmd: string, args: string[]) => handler(args),
    spawnSync: (_cmd: string, args: string[]) => ({ stdout: handler(args), stderr: "" }),
  }));
}

afterEach(() => { vi.resetModules(); vi.doUnmock("node:child_process"); });

describe("diagnoseBackendStack", () => {
  it("classifies the VectorIndex boot loop and gives the remedy", async () => {
    mockDocker((args) => {
      if (args[0] === "ps") return ["abc123", "arangodb:3.12", "restarting", "arangodb"].join(SEP);
      if (args[0] === "logs") return `some earlier line\n${FATAL_VECTOR_INDEX}`;
      return "";
    });
    const { diagnoseBackendStack } = await import("../backend-status.js");
    const f = diagnoseBackendStack();
    expect(f).not.toBeNull();
    expect(f!.service).toBe("arangodb");
    expect(f!.state).toBe("restarting");
    expect(f!.lastError).toContain("Column families not opened: VectorIndex");
    expect(f!.remedy).toContain("--vector-index true");
  });

  it("ignores a running arango", async () => {
    mockDocker((args) =>
      args[0] === "ps" ? ["abc123", "arangodb:3.12", "running", "arangodb"].join(SEP) : "");
    const { diagnoseBackendStack } = await import("../backend-status.js");
    expect(diagnoseBackendStack()).toBeNull();
  });

  it("reports an unrecognised failure without inventing a remedy", async () => {
    mockDocker((args) => {
      if (args[0] === "ps") return ["d1", "arangodb:3.12", "exited", "arangodb"].join(SEP);
      if (args[0] === "logs") return "FATAL [xxxxx] {startup} disk quota exceeded";
      return "";
    });
    const { diagnoseBackendStack } = await import("../backend-status.js");
    const f = diagnoseBackendStack();
    expect(f!.lastError).toContain("disk quota exceeded");
    expect(f!.remedy).toBeNull();
  });

  it("finds the fatal line when it arrives on stderr", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: (_c: string, args: string[]) =>
        args[0] === "ps" ? ["e1", "arangodb:3.12", "exited", "arangodb"].join(SEP) : "",
      spawnSync: () => ({ stdout: "", stderr: FATAL_VECTOR_INDEX }),
    }));
    const { diagnoseBackendStack } = await import("../backend-status.js");
    expect(diagnoseBackendStack()!.remedy).toContain("--vector-index true");
  });

  it("returns null when no arango container exists at all", async () => {
    mockDocker((args) =>
      args[0] === "ps" ? ["z1", "ghcr.io/ix-infrastructure/ix-memory-layer:latest", "exited", "memory-layer"].join(SEP) : "");
    const { diagnoseBackendStack } = await import("../backend-status.js");
    expect(diagnoseBackendStack()).toBeNull();
  });
});

describe("candidate ranking", () => {
  it("prefers a restarting container over a stale exited one", async () => {
    // The real shape this guards: a healthy install plus a long-dead arango
    // from an old experiment. Reporting the corpse's error as the current
    // outage is worse than saying nothing.
    mockDocker((args) => {
      if (args[0] === "ps") {
        return [
          ["old1", "arangodb:3.12", "exited", ""].join(SEP),
          ["live1", "arangodb:3.12", "restarting", "arangodb"].join(SEP),
        ].join("\n");
      }
      if (args[0] === "logs" && args.includes("live1")) return FATAL_VECTOR_INDEX;
      return "FATAL [zzzzz] something ancient and irrelevant";
    });
    const { diagnoseBackendStack } = await import("../backend-status.js");
    const f = diagnoseBackendStack();
    expect(f!.containerId).toBe("live1");
    expect(f!.remedy).toContain("--vector-index true");
  });

  it("prefers a compose-managed container among equals", async () => {
    mockDocker((args) => {
      if (args[0] === "ps") {
        return [
          ["hand", "arangodb:3.12", "exited", ""].join(SEP),
          ["composed", "arangodb:3.12", "exited", "arangodb"].join(SEP),
        ].join("\n");
      }
      return FATAL_VECTOR_INDEX;
    });
    const { diagnoseBackendStack } = await import("../backend-status.js");
    expect(diagnoseBackendStack()!.containerId).toBe("composed");
  });
});
