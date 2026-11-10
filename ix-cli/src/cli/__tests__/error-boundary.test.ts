// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const scratch: string[] = [];
const server = createServer((_req, res) => {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "test_failure", message: "Request failed", next: "Try later" }));
});
let endpoint: string;
let closedEndpoint: string;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  closedEndpoint = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
  await new Promise<void>((done, fail) => closed.close((err) => err ? fail(err) : done()));
});

afterAll(async () => {
  await new Promise<void>((done, fail) => server.close((err) => err ? fail(err) : done()));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], format: string, source = "flag", url = closedEndpoint, brokenConfig = false) {
  const home = mkdtempSync(join(tmpdir(), "ix-error-boundary-"));
  scratch.push(home);
  writeFileSync(join(home, "config.yaml"), brokenConfig ? "workspaces: [\n" :
      `format: ${source === "config" ? format : "text"}\nworkspaces:\n` +
      `  - workspace_id: test-workspace\n    workspace_name: test\n    root_path: ${JSON.stringify(home)}\n    default: true\n`);
  const env = {
    ...process.env, IX_HOME: home, IX_ENDPOINT: url,
    IX_FORMAT: source === "env" ? format : "", IX_DEBUG: "0",
    IX_NO_UPDATE_CHECK: "1", IX_MAP_BACKGROUND_REFRESH: "0", NO_COLOR: "1",
  };
  return new Promise<{ stdout: string; stderr: string; status: number | null }>((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args,
      ...(source === "flag" ? ["--format", format] : [])], {
      cwd: home, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", fail);
    child.on("close", (status) => done({ stdout, stderr, status }));
  });
}

function expectRecord(result: Awaited<ReturnType<typeof run>>, format: string, code: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  if (format === "json") expect(JSON.parse(result.stdout)).toMatchObject({ error: code, message: expect.any(String) });
  else expect(result.stdout).toMatch(new RegExp(`^error code=${code} message=`));
}

describe.each(["json", "llm"])("CLI boundary in %s", (format) => {
  describe.each(["flag", "env", "config"])("from %s", (source) => {
    it("answers a closed loopback backend", async () => {
      expectRecord(await run(["patches"], format, source), format, "backend_unreachable");
    });
    it("answers unknown options even before the format flag", async () => {
      expectRecord(await run(["patches", "--bogus"], format, source), format, "usage_error");
    });
  });

  it.each([["stats"], ["smells", "--list"], ["smells"], ["subsystems", "--list"], ["subsystems"]])(
    "%s forwards request failures to the boundary", async (...args) => {
      expectRecord(await run(args, format, "flag", endpoint), format, "test_failure");
    },
  );
  it("answers invalid option values", async () => {
    expectRecord(await run(["context", "x", "--depth", "bogus"], format), format, "usage_error");
  });
  it("answers missing option arguments", async () => {
    expectRecord(await run(["patches", "--limit"], format), format, "usage_error");
  });
  it("reports corrupt config using the environment format", async () => {
    expectRecord(await run(["patches"], format, "env", closedEndpoint, true), format, "config_parse_error");
  });
});

it.each([["--help"], ["--version"], ["patches", "--help"]])("%s remains a success", async (...args) => {
  const result = await run(args, "json", "env");
  expect(result.status).toBe(0);
  expect(result.stdout).not.toBe("");
  expect(result.stdout).not.toContain('"error"');
  expect(result.stderr).toBe("");
});
