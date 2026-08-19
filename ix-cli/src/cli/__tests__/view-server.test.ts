import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import * as http from "node:http";
import { browserUrl, serverRuntimeArgs, serverScript } from "../commands/view.js";

interface StartServerOptions {
  workspaceId?: string;
  systemId?: string;
  backendUrl?: string;
  useMapMainOverride?: boolean;
}

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
    distDir = mkdtempSync(join(tmpdir(), "ix view dist "));
    writeFileSync(join(distDir, "index.html"), "<h1>fake compass</h1>");
    // The server script is CommonJS, and a `.js` file's module system is
    // decided by the nearest package.json above it. Declaring this directory
    // ESM makes every test below run under the condition that used to break
    // `ix view` outright — node refusing the script with "require is not
    // defined in ES module scope" while the CLI reported only "started … but
    // is not yet serving". `ix-cli` is itself `"type": "module"`, so this is
    // the ordinary case for anyone whose IX_HOME sits inside a package.
    writeFileSync(join(distDir, "package.json"), JSON.stringify({ type: "module" }));

    // The workspace the server is scoped to. The endpoint maps this, not its
    // own cwd, so the test has to supply one.
    mapRoot = mkdtempSync(join(tmpdir(), "ix view root "));

    // The marker records every stub invocation. It lives in the temp tree and
    // is passed by env rather than written to process.cwd(): the stub's cwd is
    // MAP_ROOT now, and writing into the package root left an untracked file
    // behind whenever a run was interrupted before cleanup.
    marker = join(distDir, "stub-ran.txt");

    // A stub `ix` CLI main: the server runs `node <MAP_MAIN> map <root> --silent`.
    // STUB_MS holds it open so overlapping requests are observable; STUB_EXIT
    // drives the failure path.
    // `.cjs` for the same reason the server script is: this stub is CommonJS
    // and the directory above it now declares ESM. (The real main it stands in
    // for is ESM, so only the fixture needs saying.)
    stubMain = join(distDir, "stub-main.cjs");
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
  async function startServer(
    extraEnv: Record<string, string>,
    root: string | null = mapRoot,
    options: StartServerOptions = {},
  ) {
    await stopServer();
    const scriptPath = join(distDir, "compass-server.cjs");
    writeFileSync(scriptPath, serverScript());
    const spawned = spawn(process.execPath, [
      scriptPath,
      ...serverRuntimeArgs(
        distDir,
        port,
        options.workspaceId ?? "test-workspace",
        options.systemId ?? null,
        root,
        stubMain,
      ),
    ], {
      env: {
        ...process.env,
        NODE_ENV: options.useMapMainOverride === false ? "production" : "test",
        IX_VIEW_MAP_MAIN: options.useMapMainOverride === false ? "" : stubMain,
        IX_VIEW_BACKEND_URL: options.backendUrl ?? "",
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

  it("uses the argv CLI path outside the test-only MAP_MAIN override", async () => {
    await startServer({ STUB_EXIT: "0" }, mapRoot, { useMapMainOverride: false });
    try {
      resetRuns();
      const res = await post("/__ix/remap", { host: `127.0.0.1:${port}` });
      expect(res.status).toBe(200);
      expect(runs()).toEqual([`map ${mapRoot} --silent`]);
    } finally {
      await startServer({ STUB_EXIT: "0" });
    }
  });

  it("passes argv workspace and system scopes to proxied backend requests", async () => {
    let proxiedHeaders: http.IncomingHttpHeaders | null = null;
    const backend = http.createServer((req, res) => {
      proxiedHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(0, "127.0.0.1", resolve);
    });
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === "string") throw new Error("backend did not bind a TCP port");

    try {
      await startServer({}, mapRoot, {
        workspaceId: "workspace:test",
        systemId: "system:test",
        backendUrl: `http://127.0.0.1:${backendAddress.port}`,
      });
      const res = await fetch(`http://127.0.0.1:${port}/v1/probe?source=test`);
      expect(res.status).toBe(200);
      expect(proxiedHeaders?.["x-ix-workspace"]).toBe("workspace:test");
      expect(proxiedHeaders?.["x-ix-system"]).toBe("system:test");
    } finally {
      await stopServer();
      await new Promise<void>((resolve, reject) =>
        backend.close((err) => err ? reject(err) : resolve()),
      );
      await startServer({ STUB_EXIT: "0" });
    }
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

  it("answers 504 when the backend accepts and never replies", async () => {
    // The failure this closes: node puts no timeout on an outgoing request, so
    // a backend that accepts the socket and then goes quiet left the browser
    // waiting for ever. Compass recorded neither a result nor a failure, and
    // the region sat at "loading …" with nothing to tell a slow map from a
    // dead one. A 504 is a state the client can render.
    const hung = http.createServer(() => {
      /* accept the connection and never answer */
    });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
    const hungPort = (hung.address() as { port: number }).port;

    try {
      await startServer(
        { IX_VIEW_PROXY_TIMEOUT_MS: "300" },
        mapRoot,
        { backendUrl: `http://127.0.0.1:${hungPort}` },
      );
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      expect(res.status).toBe(504);
      expect(await res.text()).toMatch(/timed out/i);
    } finally {
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  }, 20000);

  // ── Cache headers ────────────────────────────────────────────────────────
  //
  // Reported as "it reads the new release but looks the same": rc.10 installed,
  // /.version showed the new stamp, and the screen showed the previous build.
  // The server sent no cache headers at all — which is not "do not cache". With
  // no Cache-Control, no ETag and no Last-Modified the browser picks its own
  // freshness heuristic, and `ix view` reuses 127.0.0.1 on the same port across
  // upgrades, so the entry point it cached before the upgrade is still a hit
  // after it. The old index.html then names the old hashed bundles and the
  // whole previous Compass runs, while /.version is fetched separately and
  // reports the new build.

  it("never lets the entry point be served from cache", async () => {
    await startServer({ STUB_EXIT: "0" });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("never lets the build stamp be served from cache", async () => {
    // The stamp is what a bug report quotes. A stale one is worse than none:
    // it makes the wrong build look like the right one.
    writeFileSync(join(distDir, ".version"), "0.10.0-rc.10+release.6bce261\n");
    await startServer({ STUB_EXIT: "0" });
    const res = await fetch(`http://127.0.0.1:${port}/.version`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("0.10.0-rc.10");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("keeps fingerprinted assets cacheable", async () => {
    // The point is not to disable caching — everything under assets/ is named
    // by its own content, so it is safe to keep and expensive to refetch.
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(join(distDir, "assets", "index-BbVrNAev.js"), "export const x = 1;\n");
    await startServer({ STUB_EXIT: "0" });
    const res = await fetch(`http://127.0.0.1:${port}/assets/index-BbVrNAev.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  }, 20000);

  it("does not let a missing asset poison the cache with the SPA fallback", async () => {
    // A stale index.html asks for a bundle that no longer exists. The fallback
    // answers with index.html, and caching *that* under the asset's URL is how
    // one bad load becomes permanent.
    await startServer({ STUB_EXIT: "0" });
    const res = await fetch(`http://127.0.0.1:${port}/assets/index-GONE.js`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("does not let an extensionless /assets/ miss poison the cache", async () => {
    // The case above has an extension, so it takes the readFile-error branch
    // and its hardcoded no-store — it never reaches the asset/entry decision at
    // all. Without an extension the *earlier* SPA rewrite fires instead:
    // filePath becomes index.html and readFile succeeds, so the response body
    // is the entry point while the URL still says /assets/. Choosing the policy
    // from the URL stamps that body `immutable` for a year, which is this bug
    // made permanent. Choosing it from the resolved file does not.
    await startServer({ STUB_EXIT: "0" });
    const res = await fetch(`http://127.0.0.1:${port}/assets/index-GONE`);
    expect(res.status).toBe(200);
    // Proof the body really is the entry point, not a 404 that happens to
    // carry the right header.
    expect(await res.text()).toContain("fake compass");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

});

// ── Entry-point cache busting ────────────────────────────────────────────────
//
// `no-store` fixes the *next* upgrade. It cannot fix the one the reporter just
// ran: their browser cached `/` before it, so it never issues the request that
// would carry the new header. A distinct query string is a distinct cache key,
// which is the only thing that reaches an entry the browser is not asking about.
describe("view browser URL", () => {
  let dist: string;

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "ix view stamp "));
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it("keys the opened URL on the build stamp", () => {
    writeFileSync(join(dist, ".version"), "0.10.0-rc.10+release.6bce261\n");
    expect(browserUrl("http://localhost:4173", dist)).toBe(
      "http://localhost:4173/?v=0.10.0-rc.10+release.6bce261",
    );
  });

  it("changes the key when the build changes, and only then", () => {
    // Two starts on one build must hit cache; a start after an upgrade must not.
    writeFileSync(join(dist, ".version"), "0.10.0+release.aaaaaaa\n");
    const before = browserUrl("http://localhost:4173", dist);
    expect(browserUrl("http://localhost:4173", dist)).toBe(before);
    writeFileSync(join(dist, ".version"), "0.10.1+release.bbbbbbb\n");
    expect(browserUrl("http://localhost:4173", dist)).not.toBe(before);
  });

  it("leaves the URL alone when the dist carries no stamp", () => {
    // A dev build, or a bundle from before the stamp existed. Inventing a key
    // would refetch the entry point on every start for nothing.
    const bare = mkdtempSync(join(tmpdir(), "ix view nostamp "));
    try {
      expect(browserUrl("http://localhost:4173", bare)).toBe("http://localhost:4173");
      writeFileSync(join(bare, ".version"), "  \n");
      expect(browserUrl("http://localhost:4173", bare)).toBe("http://localhost:4173");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not let a stamp file smuggle a second shell command", () => {
    // The URL is interpolated into `start`/`open`/`xdg-open` through a shell,
    // and the stamp is a file on disk rather than a string the CLI built.
    const evil = mkdtempSync(join(tmpdir(), "ix view evil "));
    try {
      writeFileSync(join(evil, ".version"), "0.10.0 & calc.exe\n");
      const opened = browserUrl("http://localhost:4173", evil);
      expect(opened).toBe("http://localhost:4173/?v=0.10.0calc.exe");
      expect(opened).not.toContain("&");
      expect(opened).not.toContain(" ");
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });
});
