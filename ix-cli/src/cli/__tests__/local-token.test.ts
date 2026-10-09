// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * SEC-02: the backend can require a bearer token (IX_LOCAL_TOKEN, local-auth
 * v1). The CLI sends one through a single header builder whenever it has one,
 * stores it opt-in, sends the stored one only to a loopback endpoint, and says
 * how to fix a 401 instead of printing the raw body.
 */

const TOKEN = "a".repeat(64);
const REPO_COMPOSE = resolve(fileURLToPath(new URL("../../../../docker-compose.standalone.yml", import.meta.url)));

// A strict backend: every request without `Authorization: Bearer TOKEN` gets
// the guard's 401, exactly as LocalRequestGuard answers it.
let server: Server;
let endpoint: string;
const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="ix-memory"' });
        res.end(JSON.stringify({ error: "unauthorized", code: "local_token_required" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/v1/capabilities")) {
        res.end(JSON.stringify({ proFeaturesEnabled: false, local_auth: "bearer-v1", local_auth_enforcing: true }));
      } else if (req.url?.startsWith("/v1/reset")) {
        res.end(JSON.stringify({ ok: true, message: "reset" }));
      } else {
        res.end(JSON.stringify({ status: "ok", exists: true, nodes: [], results: [] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  seen.length = 0;
  home = mkdtempSync(join(tmpdir(), "ix-token-"));
  saved = { IX_HOME: process.env.IX_HOME, IX_TOKEN: process.env.IX_TOKEN, IX_ENDPOINT: process.env.IX_ENDPOINT };
  process.env.IX_HOME = home;
  delete process.env.IX_TOKEN;
  delete process.env.IX_ENDPOINT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function storeToken(token: string): void {
  writeFileSync(join(home, "config.yaml"), `endpoint: ${endpoint}\nformat: text\nauth:\n  local_token: ${token}\n`);
}

describe("the client sends the token on every request", () => {
  it("every transport path carries Authorization when the client has a token", async () => {
    const { IxClient } = await import("../../client/api.js");
    const client = new IxClient(endpoint, undefined, { token: TOKEN });
    await client.search("x");                 // post()
    await client.hasIngestBaseline();         // get()
    await client.ingest("/tmp/x");            // own fetch
    await client.map();                       // own fetch
    await client.commitPatchBulk([]);         // own fetch
    await client.commitPatch({} as never);    // own fetch
    await client.savingsReset();              // DELETE, no body
    await client.reset();                     // local: synchronous reset route
    expect(seen.length).toBe(8);
    for (const r of seen) expect(r.headers.authorization, `${r.method} ${r.url}`).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no Authorization header without a token, and a 401 becomes LocalTokenRequiredError", async () => {
    const { IxClient, LocalTokenRequiredError } = await import("../../client/api.js");
    const client = new IxClient(endpoint);
    const err = await client.search("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalTokenRequiredError);
    // The `<status>: <body>` shape callers read codes out of is kept.
    expect((err as Error).message).toMatch(/^401: .*local_token_required/);
    expect(seen[0].headers.authorization).toBeUndefined();
    await expect(client.ingest("/tmp/x")).rejects.toBeInstanceOf(LocalTokenRequiredError);
  });

  it("a plain 401 without the guard's code stays an ordinary error", async () => {
    const { httpError, LocalTokenRequiredError } = await import("../../client/api.js");
    expect(httpError(401, "nope")).not.toBeInstanceOf(LocalTokenRequiredError);
    expect(httpError(401, "nope").message).toBe("401: nope");
    expect(httpError(500, '{"code":"local_token_required"}')).not.toBeInstanceOf(LocalTokenRequiredError);
  });

  it("createClient sends the stored token, and the strict backend answers", async () => {
    storeToken(TOKEN);
    const { createClient } = await import("../../client/factory.js");
    const client = createClient();
    expect(client.sendsToken).toBe(true);
    await expect(client.search("x")).resolves.toBeDefined();
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("capabilities() reports a refused token instead of falling back to {}", async () => {
    const { IxClient, LocalTokenRequiredError } = await import("../../client/api.js");
    await expect(new IxClient(endpoint).capabilities()).rejects.toBeInstanceOf(LocalTokenRequiredError);
    // Anything else still falls back, as before.
    await expect(new IxClient("http://127.0.0.1:1").capabilities()).resolves.toEqual({});
  });
});

describe("which token goes where", () => {
  it("IX_TOKEN wins, and goes to any endpoint", async () => {
    storeToken("b".repeat(64));
    process.env.IX_TOKEN = TOKEN;
    const { getLocalToken } = await import("../config.js");
    expect(getLocalToken("http://localhost:8090")).toBe(TOKEN);
    expect(getLocalToken("https://ix.example.com")).toBe(TOKEN);
  });

  it("the stored token goes only to a loopback endpoint", async () => {
    storeToken(TOKEN);
    const { getLocalToken } = await import("../config.js");
    expect(getLocalToken("http://localhost:8090")).toBe(TOKEN);
    expect(getLocalToken("http://127.0.0.1:8090")).toBe(TOKEN);
    expect(getLocalToken("http://[::1]:8090")).toBe(TOKEN);
    expect(getLocalToken("https://ix.example.com")).toBeUndefined();
    expect(getLocalToken("http://127.0.0.1.evil.com:8090")).toBeUndefined();
  });

  it("there is no token until one is asked for", async () => {
    const { getLocalToken, loadConfig } = await import("../config.js");
    expect(getLocalToken("http://localhost:8090")).toBeUndefined();
    expect(loadConfig().auth).toBeUndefined();
  });

  it("ensureLocalToken generates once, keeps the config private and other keys intact; clearLocalToken forgets it", async () => {
    writeFileSync(join(home, "config.yaml"), "endpoint: http://localhost:8090\nformat: text\ninstances:\n  - name: pro\n");
    const { ensureLocalToken, clearLocalToken, storedLocalToken } = await import("../config.js");
    const token = ensureLocalToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureLocalToken()).toBe(token);
    const onDisk = parse(readFileSync(join(home, "config.yaml"), "utf8"));
    expect(onDisk.auth.local_token).toBe(token);
    expect(onDisk.instances).toEqual([{ name: "pro" }]);
    if (process.platform !== "win32") expect(statSync(join(home, "config.yaml")).mode & 0o777).toBe(0o600);
    clearLocalToken();
    expect(storedLocalToken()).toBeUndefined();
    expect(parse(readFileSync(join(home, "config.yaml"), "utf8")).auth).toBeUndefined();
  });
});

describe("errors and doctor", () => {
  it("renders local_token_required with the fix for a local and a remote backend", async () => {
    const { localTokenRequiredError } = await import("../errors.js");
    expect(localTokenRequiredError("http://localhost:8090")).toMatchObject({
      error: "local_token_required",
      next: expect.stringContaining("ix docker start --local-token"),
    });
    expect(localTokenRequiredError("https://ix.example.com").next).toMatch(/IX_TOKEN/);
    expect(localTokenRequiredError("https://ix.example.com").next).not.toMatch(/ix docker/);
  });

  it("renderCliError prints the code, not the raw 401 body", async () => {
    const { LocalTokenRequiredError } = await import("../../client/api.js");
    const { renderCliError } = await import("../errors.js");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { lines.push(String(s)); return true; });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    expect(() => renderCliError(new LocalTokenRequiredError('{"error":"unauthorized","code":"local_token_required"}'),
      false, "http://localhost:8090")).toThrow("exit 1");
    const out = lines.join("\n");
    expect(out).toMatch(/requires a token/);
    expect(out).toMatch(/ix docker start --local-token/);
    expect(out).not.toMatch(/^Error: 401/m);
  });

  it("doctor's Backend token check", async () => {
    const { assessLocalAuth } = await import("../commands/doctor.js");
    const { LocalTokenRequiredError } = await import("../../client/api.js");
    const refused = new LocalTokenRequiredError("{}");
    expect(assessLocalAuth(refused, false, true)).toMatchObject({ ok: false, detail: expect.stringMatching(/has none/) });
    expect(assessLocalAuth(refused, true, true)).toMatchObject({ ok: false, detail: expect.stringMatching(/refused/) });
    expect(assessLocalAuth(new Error("fetch failed"), false, true)).toMatchObject({ ok: true, detail: expect.stringMatching(/unreachable/) });
    expect(assessLocalAuth({ proFeaturesEnabled: false }, false, true)).toMatchObject({ ok: true, detail: expect.stringMatching(/predates/) });
    expect(assessLocalAuth({ local_auth: "bearer-v1", local_auth_enforcing: true }, true, true)).toMatchObject({ ok: true });
    expect(assessLocalAuth({ local_auth: "bearer-v1", local_auth_enforcing: false }, true, true)).toMatchObject({ ok: false, warn: true });
    expect(assessLocalAuth({ local_auth: "bearer-v1", local_auth_enforcing: false }, false, true)).toMatchObject({
      ok: true, detail: expect.stringMatching(/not required/),
    });
  });
});

describe("the backend compose file", () => {
  const compose = parse(readFileSync(REPO_COMPOSE, "utf8"));

  it("publishes no ArangoDB port", () => {
    expect(compose.services.arangodb.ports).toBeUndefined();
    // The memory layer is still reachable, on loopback only.
    expect(compose.services["memory-layer"].ports).toEqual(["127.0.0.1:8090:8090"]);
  });

  it("passes IX_LOCAL_TOKEN to the memory layer, empty by default", async () => {
    expect(compose.services["memory-layer"].environment.IX_LOCAL_TOKEN).toBe("${IX_LOCAL_TOKEN:-}");
    const { composeSupportsLocalToken } = await import("../backend-compose.js");
    expect(composeSupportsLocalToken(readFileSync(REPO_COMPOSE, "utf8"))).toBe(true);
    expect(composeSupportsLocalToken("services:\n  memory-layer:\n    image: x\n")).toBe(false);
  });

  it(".env keeps the user's other lines and replaces only IX_LOCAL_TOKEN", async () => {
    const { backendEnvContents, writeBackendEnv } = await import("../backend-compose.js");
    expect(backendEnvContents("", undefined)).toBe("IX_LOCAL_TOKEN=\n");
    expect(backendEnvContents("FOO=1\nIX_LOCAL_TOKEN=old\nexport IX_LOCAL_TOKEN=older\n", TOKEN))
      .toBe(`FOO=1\nIX_LOCAL_TOKEN=${TOKEN}\n`);
    const env = join(home, "backend", ".env");
    writeBackendEnv(TOKEN, env);
    expect(readFileSync(env, "utf8")).toBe(`IX_LOCAL_TOKEN=${TOKEN}\n`);
    if (process.platform !== "win32") expect(statSync(env).mode & 0o777).toBe(0o600);
  });

  it("reads the arangodb container's health from compose ps, in either output shape", async () => {
    const { parseArangoHealth } = await import("../backend-compose.js");
    const row = (service: string, health: string) => JSON.stringify({ Service: service, Health: health, State: "running" });
    expect(parseArangoHealth("")).toBe("absent");
    expect(parseArangoHealth(row("arangodb", "healthy"))).toBe("healthy");
    expect(parseArangoHealth(`${row("memory-layer", "healthy")}\n${row("arangodb", "unhealthy")}`)).toBe("unhealthy");
    expect(parseArangoHealth(`[${row("arangodb", "starting")}]`)).toBe("starting");
    expect(parseArangoHealth(row("memory-layer", "healthy"))).toBe("absent");
  });
});
