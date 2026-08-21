import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { serverRuntimeArgs, serverScript } from "../commands/view.js";

/** Pick a free TCP port. */
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

describe("view routes — /__ix/* 404 (#473)", () => {
  let distDir: string;
  let stubMain: string;
  let child: ChildProcess | null = null;
  let port = 0;

  beforeAll(async () => {
    distDir = mkdtempSync(join(tmpdir(), "ix view routes "));
    writeFileSync(join(distDir, "index.html"), "<!doctype html><html><body>fake</body></html>");
    writeFileSync(join(distDir, "package.json"), JSON.stringify({ type: "module" }));

    // Stub CLI main
    stubMain = join(distDir, "stub-main.cjs");
    writeFileSync(stubMain, 'process.exit(0);');

    port = await getFreePort();
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
    rmSync(distDir, { recursive: true, force: true });
  });

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

  async function startServer() {
    await stopServer();
    const scriptPath = join(distDir, "compass-server.cjs");
    writeFileSync(scriptPath, serverScript());
    child = spawn(process.execPath, [
      scriptPath,
      ...serverRuntimeArgs(distDir, port, "test-workspace", null, null, stubMain),
    ], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        IX_VIEW_MAP_MAIN: stubMain,
        IX_VIEW_BACKEND_URL: "",
      },
      stdio: "ignore",
    });
    child.once("error", () => {});
    await waitForPort(port);
  }

  // ── Route matching: /__ix/* routes do NOT serve HTML ──

  const apiRoutes = ["/__ix/read", "/__ix/explain", "/__ix/inventory", "/__ix/help"];

  for (const route of apiRoutes) {
    it(`${route} returns 404 JSON, not HTML`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "test", path: "src/test.ts", range: "1-10" }),
      });
      expect(res.status).toBe(404);
      const contentType = res.headers.get("content-type") || "";
      expect(contentType).toContain("application/json");
      const body = await res.text();
      expect(body).not.toContain("<!doctype html>");
      expect(body).not.toContain("<html");
      const json = JSON.parse(body);
      expect(json.ok).toBe(false);
      expect(json.error).toContain("not found");
    });
  }

  // ── Unmatched /__ix/* routes return 404 ──

  it("unknown /__ix/ route returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/nonexistent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("/__ix/ with no path returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("__ix route with GET method returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`);
    expect(res.status).toBe(404);
  });

  // ── /__ix/remap still works ──

  it("/__ix/remap still handles POST (not broken by 404 handler)", async () => {
    // remap requires loopback origin — test that it's NOT caught by the 404
    const res = await fetch(`http://127.0.0.1:${port}/__ix/remap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    // Should be 403 (CSRF rejection) or 409/200, NOT 404
    expect(res.status).not.toBe(404);
  });

  // ── Input validation (security) ──

  it("rejects path traversal in entity name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: "../../etc/passwd",
        path: "../../etc/passwd",
        range: "1-10",
      }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("root:");
  });

  it("rejects command injection in entity name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity: "test; rm -rf /",
        path: "src/test.ts",
        range: "1-10",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty entity name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "", path: "src/test.ts", range: "1-10" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(404);
  });

  // ── Response format ──

  it("response is parseable JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "test", path: "src/test.ts", range: "1-10" }),
    });
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("error message includes the route path", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "test" }),
    });
    const json = await res.json();
    expect(json.error).toContain("/__ix/explain");
  });

  it("Cache-Control is no-store", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "test" }),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // ── Edge cases ──

  it("handles concurrent requests to /__ix/read", async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      fetch(`http://127.0.0.1:${port}/__ix/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: `Entity${i}`, path: `src/file${i}.ts`, range: "1-10" }),
      }),
    );
    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(404);
    }
  });

  it("handles very large range", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "test", path: "src/test.ts", range: "1-999999" }),
    });
    expect(res.status).toBe(404);
  });

  it("handles missing Content-Type header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__ix/read`, {
      method: "POST",
      body: JSON.stringify({ entity: "test" }),
    });
    expect(res.status).toBe(404);
  });

  // ── SPA routes still work ──

  it("SPA fallback still serves index.html for non-API routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some-spa-route`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
  });

  it("/ serves index.html", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
  });
});
