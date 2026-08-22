import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn((..._args: unknown[]) => ""),
}));

vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CURRENT_CLI_VERSION = JSON.parse(
  readFileSync(join(TEST_DIR, "..", "..", "..", "package.json"), "utf-8"),
).version as string;
const BACKEND_IMAGE = "ghcr.io/ix-infrastructure/ix-memory-layer";

let home: string;
let originalIxHome: string | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  originalIxHome = process.env.IX_HOME;
  home = mkdtempSync(join(tmpdir(), "ix-upgrade-pinned-compose-"));
  process.env.IX_HOME = home;
  mkdirSync(join(home, "backend"), { recursive: true });
  writeFileSync(join(home, ".backend-version"), "1.0.16");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ix-memory-layer-dist/")) {
        return new Response(JSON.stringify({ tag_name: "v1.0.17" }), { status: 200 });
      }
      if (url.includes("/ix-compass-dist/")) {
        return new Response("", { status: 404 });
      }
      return new Response(JSON.stringify({ tag_name: `v${CURRENT_CLI_VERSION}` }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  if (originalIxHome === undefined) delete process.env.IX_HOME;
  else process.env.IX_HOME = originalIxHome;
});

async function runUpgrade(compose: string, args: string[] = []): Promise<string> {
  writeFileSync(join(home, "backend", "docker-compose.yml"), compose);

  const { registerUpgradeCommand } = await import("../commands/upgrade.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerUpgradeCommand(program);

  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    output.push(values.join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    output.push(values.join(" "));
  });
  try {
    await program.parseAsync(["upgrade", ...args], { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return output.join("\n");
}

function dockerCalls(): string[][] {
  return mocks.execFileSync.mock.calls
    .filter(([command]) => command === "docker")
    .map(([, args]) => args as string[]);
}

describe("ix upgrade with an existing backend compose", () => {
  it.each([
    ["tag", `${BACKEND_IMAGE}:1.0.16`],
    ["digest", `${BACKEND_IMAGE}@sha256:944f76887832`],
  ])("leaves a pinned %s, its version stamp, and its backend unchanged", async (_kind, image) => {
    const compose = `services:\n  memory-layer:\n    image: ${image}\n`;
    const output = await runUpgrade(compose);

    expect(readFileSync(join(home, "backend", "docker-compose.yml"), "utf-8")).toBe(compose);
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.16");
    expect(dockerCalls()).not.toContainEqual(["pull", `${BACKEND_IMAGE}:latest`]);
    expect(dockerCalls().some(([command]) => command === "compose")).toBe(false);
    expect(output).toContain("Backend not upgraded");
    expect(output).toContain("Left the compose file and backend version stamp unchanged.");
    expect(output).not.toContain("Backend image updated to 1.0.17");
    expect(output).not.toContain("Backend restarted with latest image");
    expect(output).not.toContain("[ok] ix is up to date");
    expect(output).toContain("ix upgrade finished with the backend unchanged");
  });

  it("does not trust a current stamp left by an earlier upgrade over a pinned compose", async () => {
    writeFileSync(join(home, ".backend-version"), "1.0.17");
    const compose = `services:\n  memory-layer:\n    image: ${BACKEND_IMAGE}@sha256:944f76887832\n`;
    const output = await runUpgrade(compose);

    expect(readFileSync(join(home, "backend", "docker-compose.yml"), "utf-8")).toBe(compose);
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.17");
    expect(dockerCalls()).not.toContainEqual(["pull", `${BACKEND_IMAGE}:latest`]);
    expect(dockerCalls().some(([command]) => command === "compose")).toBe(false);
    expect(output).toContain("Backend not upgraded");
    expect(output).not.toContain("Backend already on the latest version");
    expect(output).not.toContain("[ok] ix is up to date");
    expect(output).toContain("ix upgrade finished with the backend unchanged");
  });

  it("leaves the separate --check behavior unchanged", async () => {
    writeFileSync(join(home, ".backend-version"), "1.0.17");
    const compose = `services:\n  memory-layer:\n    image: ${BACKEND_IMAGE}@sha256:944f76887832\n`;
    const output = await runUpgrade(compose, ["--check"]);

    expect(output).not.toContain("Backend not upgraded");
    expect(output).toContain("Backend already on the latest version (1.0.17)");
    expect(output).toContain("[ok] ix is up to date");
    expect(dockerCalls()).toEqual([]);
  });

  it("still upgrades a compose that tracks the released latest image", async () => {
    const compose = `services:\n  memory-layer:\n    image: ${BACKEND_IMAGE}:latest\n`;
    const output = await runUpgrade(compose);

    expect(readFileSync(join(home, "backend", "docker-compose.yml"), "utf-8")).toBe(compose);
    expect(readFileSync(join(home, ".backend-version"), "utf-8")).toBe("1.0.17");
    expect(dockerCalls()).toContainEqual(["pull", `${BACKEND_IMAGE}:latest`]);
    expect(dockerCalls().some(([command]) => command === "compose")).toBe(true);
    expect(output).toContain("Backend image updated to 1.0.17");
    expect(output).toContain("Backend restarted with latest image");
    expect(output).toContain("[ok] ix is up to date");
  });
});
