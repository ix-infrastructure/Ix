import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import * as http from "node:http";
import { serverScript } from "../commands/view.js";

/** Pick a free TCP port by binding port 0 and releasing it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Wait until a TCP port accepts connections. */
async function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      res.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on port ${port} did not start`);
}

describe("view server (/__ix/remap)", () => {
  let distDir: string;
  let mapRoot: string;
  let stubMain: string;
  let marker: string;
  let child: ChildProcess | null = null;
  let port = 0;

  beforeAll(async () => {
    // A fake Compass dist: index.html is the SPA entry the fallback serves.
    distDir = mkdtempSync(join(tmpdir(), "ix-view-dist-"));
    writeFileSync(join(distDir, "index.html"), "<h1>fake compass</h1>");

    // The workspace the server is scoped to. The endpoint maps this, not its
    // own cwd, so the test has to supply one.
    mapRoot = mkdtempSync(join(tmpdir(), "ix-view-root-"));

    // The marker records every stub invocation. It lives in the temp tree and
    // is passed by env rather than written to process.cwd(): the stub's cwd is
    // MAP_ROOT now, and writing into the package root left an untracked file
    // behind whenever a run was interrupted before cleanup.
    marker = join(distDir, "stub-ran.txt");

    // A stub `ix` CLI main: the server runs `node <MAP_MAIN> map <root> --silent`.
    // STUB_MS holds it open so overlapping requests are observable; STUB_EXIT
    // drives the failure path.
    stubMain = join(distDir, "stub-main.js");
    writeFileSync(
      stubMain,
      [
        'const fs = require("fs");',
        "fs.appendFileSync(process.env.STUB_MARKER, process.argv.slice(2).join(\" \") + \"\\n\");",
        "const ms = Number(process.env.STUB_MS || 0);",
        "const done = () => process.exit(Number(process.env.STUB_EXIT || 0));",
        "if (ms > 0) setTimeout(done, ms); else done();",
      ].join("\n"),
    );

    port = await getFreePort();
    const script = serverScript();
    // The generated script must survive template-literal emission intact.
    expect(script).toContain('"/__ix/remap"');
    expect(script).toContain("IX_VIEW_MAP_MAIN");
    expect(script).toContain('server.listen(PORT, "127.0.0.1"');
    // Backend-derived scope is supplied only at runtime, never written into
    // the generated executable script.
    expect(script).toContain("const SYSTEM_ID = process.argv[5] || null");

    await startServer({ STUB_EXIT: "0" });
  });

  afterAll(async () => {
    await stopServer();
    rmSync(distDir, { recursive: true, force: true });
    rmSync(mapRoot, { recursive: true, force: true });
  });

  /** Kill the running server and wait for the socket to be released. */
  async function stopServer(): Promise<void> {
    if (!child) return;
    const dying = child;
    child = null;
    if (dying.exitCode !== null || dying.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      dying.once("exit", () => resolve());
      dying.kill();
    });
  }

  /**
   * Replace the running server.
   *
   * Awaiting the old child's exit matters: kill() returns when SIGTERM is sent,
   * not when it lands, so spawning the replacement on the same port immediately
   * could lose the bind to EADDRINUSE — invisibly, because stdio is ignored —
   * while waitForPort was satisfied by the still-dying old server.
   */
  async function startServer(extraEnv: Record<string, string>, root: string | null = mapRoot) {
    await stopServer();
    const scriptPath = join(distDir, "compass-server.js");
    writeFileSync(scriptPath, serverScript());
    const spawned = spawn(process.execPath, [
      scriptPath,
      distDir,
      String(port),
      "test-workspace",
      "",
      root ?? "",
      stubMain,
    ], {
      env: {
        ...process.env,
        NODE_ENV: "test", // the IX_VIEW_MAP_MAIN seam is honoured only under this
        IX_VIEW_MAP_MAIN: stubMain,
        STUB_MARKER: marker,
        STUB_MS: "0",
        ...extraEnv,
      },
      stdio: "ignore",
    });
    // A server that dies on startup would otherwise surface as a timeout in
    // waitForPort with no indication of why.
    spawned.once("error", () => { /* surfaced by waitForPort */ });
    child = spawned;
    await waitForPort(port);
  }

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers });

  const runs = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : []);
  const resetRuns = () => writeFileSync(marker, "");

  it("rejects a cross-site Origin (CSRF) with 403", async () => {
    const res = await post("/__ix/remap", { origin: "https://evil.example", host: `127.0.0.1:${port}` });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "forbidden: loopback only" });
  });

  it("rejects a DNS-rebinding Host with 403", async () => {
    // fetch/undici refuses to send a custom Host header, so use http.request,
    // which lets the Host header differ from the connection target — the exact
    // DNS-rebinding scenario.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/__ix/remap", method: "POST", headers: { host: "attacker.example" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects a malformed Origin with 403", async () => {
    const res = await post("/__ix/remap", { origin: "not a url", host: `127.0.0.1:${port}` });
    expect(res.status).toBe(403);
  });

  it("rejects a non-loopback Origin even when the Host is loopback", async () => {
    const res = await post("/__ix/remap", { origin: "http://10.0.0.5:8080", host: `127.0.0.1:${port}` });
    expect(res.status).toBe(403);
  });

  it("rejects a loopback Origin on a different port", async () => {
    // Loopback is not one origin. Any page served on another localhost port can
    // send this exact POST with no preflight, so accepting the whole interface
    // let a local dev server or docs site trigger a remap.
    resetRuns();
    const res = await post("/__ix/remap", { origin: `http://localhost:${port + 1}`, host: `127.0.0.1:${port}` });
    expect(res.status).toBe(403);
    expect(runs()).toHaveLength(0);
  });

  it("accepts a bracketed IPv6 loopback Host ([::1]:port)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/__ix/remap", method: "POST", headers: { host: `[::1]:${port}` } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it("accepts a no-Origin (curl-style) POST and maps the scoped workspace", async () => {
    resetRuns();
    const res = await post("/__ix/remap", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The recorded workspace root, never the server's own cwd, and --silent
    // because nothing reads the output.
    expect(runs()).toEqual([`map ${mapRoot} --silent`]);
  });

  it("accepts a same-origin loopback Origin", async () => {
    const res = await post("/__ix/remap", { origin: `http://localhost:${port}`, host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("refuses a second remap while one is in flight", async () => {
    await startServer({ STUB_MS: "1200" });
    resetRuns();
    const first = post("/__ix/remap", { host: `127.0.0.1:${port}` });
    // Let the first request reach the spawn before the second arrives.
    await new Promise((r) => setTimeout(r, 300));
    const second = await post("/__ix/remap", { host: `127.0.0.1:${port}` });

    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already running/);
    expect((await first).status).toBe(200);
    expect(runs()).toHaveLength(1);

    // The slot is released, so the next one is accepted rather than wedged.
    await startServer({ STUB_EXIT: "0" });
    expect((await post("/__ix/remap", { host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  it("refuses to remap when the view is unscoped (--all)", async () => {
    await startServer({ STUB_EXIT: "0" }, null);
    resetRuns();
    const res = await post("/__ix/remap", { host: `127.0.0.1:${port}` });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/--all/);
    // The point of the guard: nothing was mapped. Falling back to the server's
    // cwd here is what could ingest a home directory.
    expect(runs()).toHaveLength(0);

    await startServer({ STUB_EXIT: "0" });
  });

  it("returns ok:false when the map command fails", async () => {
    await startServer({ STUB_EXIT: "1" });
    const res = await post("/__ix/remap", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("still serves the SPA index.html for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fake compass");
  });

  it("does not treat GET /__ix/remap as the endpoint (SPA fallback)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/remap`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fake compass");
  });
});
