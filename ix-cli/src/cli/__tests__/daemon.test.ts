// Copyright 2026 Ix Infrastructure Inc.

// The warm daemon against the built CLI: every call here is a real `ix`
// process, and a warm answer is checked byte for byte against the same call
// run cold (IX_DAEMON=off). Each test has its own IX_HOME and runtime
// directory, so its own daemon, and stops it afterwards.
//
// Needs `npm run build` (CI builds before the unit tests): the daemon runs
// from dist/, never from source.

import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { request } from "../daemon/client.js";
import { confinement, daemonPaths, PROTOCOL_VERSION, type DaemonReply, type RunRequest } from "../daemon/protocol.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(CLI_ROOT, "dist", "cli", "main.js");
const built = existsSync(join(CLI_ROOT, "dist", "cli", "daemon", "server.js"));

/**
 * This test process's confinement. Where it is itself sandboxed (no_new_privs:
 * some CI and agent sandboxes), the daemon is opted in explicitly, as a user
 * in such a container would; everywhere else the tests run without it.
 */
const ownConfinement = confinement();
const confinedOptIn: NodeJS.ProcessEnv = ownConfinement.confined ? { IX_DAEMON_ALLOW_CONFINED: "1" } : {};
const setpriv = ["/usr/bin/setpriv", "/bin/setpriv"].find((p) => existsSync(p));

interface Result { status: number | null; stdout: Buffer; stderr: Buffer }

function ix(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<Result> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface FakeBackend { server: Server; url: string; delayMs: number }

/** A fake Ix backend: enough of the API for the read commands to answer, after `delayMs`. */
function fakeBackend(): Promise<FakeBackend> {
  const node = {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "function",
    name: "foo",
    attrs: { line_start: 1, line_end: 1 },
    provenance: { source_uri: "a.ts" },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let out: unknown = {};
      const url = req.url ?? "";
      if (url.startsWith("/v1/search")) {
        let term: unknown;
        try { term = JSON.parse(body || "{}").term; } catch { /* not JSON */ }
        out = term === "foo" ? [node] : [];
      } else if (url.startsWith("/v1/entity/")) out = { node, claims: [], decisions: [], history: [] };
      else if (url.startsWith("/v1/expand")) out = { nodes: [], edges: [] };
      else if (url.startsWith("/v1/provenance")) out = [];
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      }, fake.delayMs);
    });
  });
  const fake: FakeBackend = { server, url: "", delayMs: 0 };
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    fake.url = `http://127.0.0.1:${addr.port}`;
    r(fake);
  }));
}

describe.skipIf(process.platform === "win32" || !built)("the warm daemon", () => {
  let base: string;
  let ixHome: string;
  let runtime: string;
  let ws: string;
  let ws2: string;
  let backend: FakeBackend;
  let env: NodeJS.ProcessEnv;

  const socket = () => daemonPaths({ IX_HOME: ixHome, XDG_RUNTIME_DIR: runtime })!.socket;
  const logText = () => { try { return readFileSync(join(ixHome, "daemon", "daemon.log"), "utf8"); } catch { return ""; } };

  async function info(): Promise<Extract<DaemonReply, { status: "info" }> | undefined> {
    const a = await request(socket(), { v: PROTOCOL_VERSION, kind: "status" }, 2000);
    return a.kind === "reply" && a.reply.status === "info" ? a.reply : undefined;
  }

  /** Start the daemon the way a first call does, and wait until it answers. */
  async function startDaemon(extra: NodeJS.ProcessEnv = {}) {
    const first = await ix(["text", "zzz-no-such-term"], { cwd: ws, env: { ...env, ...extra } });
    expect(first.status).toBe(0);
    return until(info, "the daemon to answer");
  }

  async function stopDaemon(): Promise<void> {
    const i = await info();
    if (!i) return;
    await request(socket(), { v: PROTOCOL_VERSION, kind: "stop" }, 2000);
    await until(() => !alive(i.pid) || undefined, "the daemon to exit", 10_000).catch(() => process.kill(i.pid, "SIGKILL"));
  }

  /** Cold, then warm; the daemon must have answered the warm one, and identically. */
  async function expectSame(args: string[], opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    /** Run between the cold and the warm call, to undo what the cold one wrote. */
    between?: () => void;
    /** For stderr that differs between any two runs, cold or warm: ids, timings. */
    normalizeStderr?: (text: string) => string;
  } = {}) {
    const callEnv = { ...env, ...opts.env };
    const cwd = opts.cwd ?? ws;
    const cold = await ix(args, { cwd, env: { ...callEnv, IX_DAEMON: "off" }, input: opts.input });
    opts.between?.();
    const before = (await info())!.served;
    const warm = await ix(args, { cwd, env: callEnv, input: opts.input });
    const after = (await info())!.served;
    const label = args.join(" ");
    expect(after, `${label}: answered by the daemon`).toBe(before + 1);
    expect(warm.stdout.toString("utf8"), `${label}: stdout`).toBe(cold.stdout.toString("utf8"));
    expect(warm.stdout.equals(cold.stdout), `${label}: stdout bytes`).toBe(true);
    if (opts.normalizeStderr) {
      const n = opts.normalizeStderr;
      expect(n(warm.stderr.toString("utf8")), `${label}: stderr`).toBe(n(cold.stderr.toString("utf8")));
    } else {
      expect(warm.stderr.toString("utf8"), `${label}: stderr`).toBe(cold.stderr.toString("utf8"));
      expect(warm.stderr.equals(cold.stderr), `${label}: stderr bytes`).toBe(true);
    }
    expect(warm.status, `${label}: exit code`).toBe(cold.status);
    return warm;
  }

  beforeEach(async () => {
    // Short: macOS caps a socket path at 104 bytes.
    base = mkdtempSync(join(tmpdir(), "ixd-"));
    ixHome = join(base, "h");
    runtime = join(base, "r");
    ws = join(base, "ws");
    ws2 = join(base, "ws2");
    for (const d of [ixHome, runtime, ws, ws2]) mkdirSync(d, { recursive: true });
    backend = await fakeBackend();
    writeFileSync(join(ws, "a.ts"), "function foo() {}\nexport const bar = foo;\n");
    writeFileSync(join(ws2, "a.ts"), "// another checkout\nfunction foo() { return 2; }\n");
    writeFileSync(join(ixHome, "config.yaml"),
      `endpoint: ${backend.url}\nworkspaces:\n` +
      `  - workspace_id: "abcd1234"\n    workspace_name: ws\n    root_path: ${ws}\n    default: true\n`);
    env = {
      ...process.env, IX_HOME: ixHome, XDG_RUNTIME_DIR: runtime, IX_NO_UPDATE_CHECK: "1", IX_DAEMON_IDLE_SECONDS: "120",
      ...confinedOptIn,
    };
    delete env.IX_DAEMON;
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    delete env.IX_ENDPOINT;
    delete env.NODE_OPTIONS;
  });

  /** A run request as the client would send it, with `extra` over the test env. */
  async function runRequestFor(argv: string[], extra: Record<string, string> = {}, over: Partial<RunRequest> = {}): Promise<RunRequest> {
    const plain = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    return {
      v: PROTOCOL_VERSION, kind: "run", build: (await info())!.build, argv, cwd: ws,
      env: { ...plain, ...extra }, confinement: ownConfinement.key, startedAt: Date.now(), ...over,
    };
  }

  /** An `rg` that takes `seconds`, for runs that should keep the daemon busy. */
  function slowRgEnv(seconds: number): NodeJS.ProcessEnv {
    const slowBin = join(base, `slow-bin-${seconds}`);
    mkdirSync(slowBin, { recursive: true });
    writeFileSync(join(slowBin, "rg"), `#!/bin/sh\nsleep ${seconds}\nexit 1\n`);
    chmodSync(join(slowBin, "rg"), 0o755);
    return { ...env, PATH: `${slowBin}:${env.PATH ?? ""}` };
  }

  afterEach(async () => {
    await stopDaemon();
    backend.server.closeAllConnections();
    await new Promise((r) => backend.server.close(r));
    rmSync(base, { recursive: true, force: true });
  });

  it("starts itself on a first call that runs cold, with a 0700 directory and a 0600 socket", async () => {
    expect(existsSync(socket())).toBe(false);
    const status = await startDaemon();
    expect(status.served).toBe(0);
    expect(statSync(dirname(socket())).mode & 0o777).toBe(0o700);
    expect(statSync(socket()).mode & 0o777).toBe(0o600);
    expect(logText()).toMatch(/listening on/);
  }, 30_000);

  it.skipIf(process.platform !== "linux")("does not keep the starting call's credentials in its own environment", async () => {
    const first = await ix(["text", "zzz-no-such-term"], { cwd: ws, env: { ...env, IX_TOKEN: "tok-123", GITHUB_TOKEN: "gh-456" } });
    expect(first.status).toBe(0);
    const d = await until(info, "the daemon");
    const own = readFileSync(`/proc/${d.pid}/environ`, "utf8").split("\0");
    expect(own.some((kv) => kv.startsWith("IX_TOKEN=") || kv.startsWith("GITHUB_TOKEN="))).toBe(false);
    expect(own).toContain(`IX_HOME=${ixHome}`);
  }, 30_000);

  it("two concurrent first calls start exactly one daemon", async () => {
    const calls = await Promise.all([0, 1, 2, 3].map(() => ix(["text", "zzz-no-such-term"], { cwd: ws, env })));
    for (const c of calls) expect(c.status).toBe(0);
    const first = await until(info, "the daemon");
    await sleep(500);
    expect((logText().match(/listening on/g) ?? []).length).toBe(1);
    expect((await info())!.pid).toBe(first.pid);
  }, 30_000);

  it("answers each allowlisted command exactly as the cold path does", async () => {
    await startDaemon();
    // Success.
    await expectSame(["text", "foo"]);
    await expectSame(["read", "a.ts"]);
    await expectSame(["locate", "foo"]);
    await expectSame(["search", "foo"]);
    await expectSame(["explain", "foo"]);
    await expectSame(["callers", "foo"]);
    await expectSame(["impact", "foo"]);
    // No results.
    await expectSame(["text", "zzz-no-such-term"]);
    await expectSame(["locate", "nothere"]);
    await expectSame(["search", "nothere", "--format", "json"]);
    // A failing command (the fake backend lacks what context needs) and a
    // target that is on disk but not in the graph.
    await expectSame(["context", "foo"]);
    await expectSame(["around", "a.ts:1"]);
    // Invalid options: validation and commander's own.
    await expectSame(["text", "foo", "--limit", "abc"]);
    await expectSame(["locate", "foo", "--no-such-flag"]);
    await expectSame(["callers"]);
    // Output shape.
    await expectSame(["locate", "foo", "--format", "json"]);
    await expectSame(["locate", "foo", "--format", "json", "--pretty"]);
    await expectSame(["callers", "foo", "--quiet"]);
    await expectSame(["text", "foo", "--fields", "path", "--format", "llm"]);
    await expectSame(["search", "foo", "--format", "llm", "--fields", "name,path"]);
  }, 120_000);

  it("answers a backend that is down, and an unmapped directory, exactly as the cold path does", async () => {
    await startDaemon();
    const down = { IX_ENDPOINT: "http://127.0.0.1:1" };
    await expectSame(["locate", "foo"], { env: down });
    await expectSame(["explain", "foo", "--format", "json"], { env: down });
    await expectSame(["impact", "foo", "--format", "llm"], { env: down });
    await expectSame(["search", "foo"], { cwd: ws2 });
    await expectSame(["locate", "foo", "--format", "json"], { cwd: ws2 });
  }, 60_000);

  it("keeps cwd and environment per call: consecutive calls do not leak into each other", async () => {
    await startDaemon();
    await expectSame(["read", "a.ts"], { cwd: ws2 });
    await expectSame(["read", "a.ts"], { cwd: ws });
    await expectSame(["locate", "foo"], { env: { IX_FORMAT: "json" } });
    await expectSame(["locate", "foo"]);
    await expectSame(["locate", "foo"], { env: { IX_FORMAT: "llm" } });
    await expectSame(["search", "foo"], { env: { IX_ENDPOINT: "http://127.0.0.1:1" } });
    await expectSame(["search", "foo"]);
    // The correlation id is random per invocation, cold or warm.
    await expectSame(["locate", "foo"], {
      env: { IX_DEBUG: "1", IX_ENDPOINT: "http://127.0.0.1:1" },
      normalizeStderr: (t) => t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"),
    });
    // A run never leaves its environment behind in the daemon.
    await expectSame(["text", "foo", "--format", "json"], { env: { IX_FORMAT: "llm" } });
    await expectSame(["text", "foo"]);
  }, 90_000);

  it("feeds `ix hook claude-post-edit` its stdin byte for byte, and `context --from-issue -` too", async () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
    writeFileSync(join(ws, "a.ts"), "function foo() { return 1; }\nexport const bar = foo;\n");
    await startDaemon();
    const hookInput = (session: string) =>
      JSON.stringify({ session_id: session, tool_name: "Edit", cwd: ws, tool_input: { file_path: join(ws, "a.ts") } });
    // The hook remembers what it reported per session; the cold run's memory
    // goes before the warm run, which must then do exactly the same work.
    const stateDir = join(base, "hook-state");
    const forget = () => rmSync(stateDir, { recursive: true, force: true });
    const hookEnv = { IX_HOOK_STATE_DIR: stateDir };
    const timing = (t: string) => t.replace(/ in \d+ ms/g, " in <n> ms");
    await expectSame(["hook", "claude-post-edit"], { input: hookInput("s1"), env: hookEnv, between: forget });
    await expectSame(["hook", "claude-post-edit"], {
      input: hookInput("s2"), env: { ...hookEnv, IX_HOOK_DEBUG: "1" }, between: forget, normalizeStderr: timing,
    });
    await expectSame(["hook", "claude-post-edit", "--budget", "50"], {
      input: hookInput("s3"), env: { ...hookEnv, IX_HOOK_DEBUG: "1", IX_ENDPOINT: "http://127.0.0.1:1" }, between: forget, normalizeStderr: timing,
    });
    await expectSame(["hook", "claude-post-edit"], { input: "not json", env: { ...hookEnv, IX_HOOK_DEBUG: "1" }, normalizeStderr: timing });
    await expectSame(["hook", "claude-post-edit"], { input: "" });
    await expectSame(["context", "--from-issue", "-", "--format", "json"], { input: "The foo function is broken ✓" });
  }, 60_000);

  it("hands back a call whose locale or Node settings differ from the ones it started with", async () => {
    await startDaemon();
    for (const extra of [{ LANG: "xx_XX.UTF-8" }, { LC_ALL: "C" }, { NODE_EXTRA_CA_CERTS: join(base, "ca.pem") }]) {
      const before = (await info())!;
      const cold = await ix(["read", "a.ts"], { cwd: ws, env: { ...env, ...extra, IX_DAEMON: "off" } });
      const call = await ix(["read", "a.ts"], { cwd: ws, env: { ...env, ...extra } });
      expect(call.stdout.equals(cold.stdout)).toBe(true);
      expect(call.stderr.equals(cold.stderr)).toBe(true);
      expect(call.status).toBe(cold.status);
      const after = (await info())!;
      expect(after.served).toBe(before.served);
      expect(after.fallbacks).toBe(before.fallbacks + 1);
    }
    // A call that would load every command (as with Pro installed) is not one
    // it answers either.
    const raw = await request(socket(), await runRequestFor(["read", "a.ts"], { IX_LOAD_ALL_COMMANDS: "1" }), 5000);
    expect(raw.kind === "reply" && raw.reply).toEqual({ status: "fallback", reason: "registry" });
  }, 30_000);

  it("answers busy to a third request while one runs and one waits; that call runs cold", async () => {
    // Long enough for the second to still be waiting when the third arrives.
    await startDaemon({ IX_DAEMON_QUEUE_WAIT_MS: "20000" });
    const slow = slowRgEnv(3);
    const slowCold = await ix(["text", "slow"], { cwd: ws, env: { ...slow, IX_DAEMON: "off" } });

    const a = ix(["text", "slow"], { cwd: ws, env: slow });
    await until(async () => (await info())?.active || undefined, "the first run to start");
    const b = ix(["text", "slow"], { cwd: ws, env: slow });
    await until(async () => ((await info())?.queued ?? 0) >= 1 || undefined, "the second run to queue");

    const raw = await request(socket(), await runRequestFor(["text", "foo"]), 5000);
    expect(raw.kind === "reply" && raw.reply.status).toBe("busy");

    const coldRef = await ix(["text", "foo"], { cwd: ws, env: { ...env, IX_DAEMON: "off" } });
    const third = await ix(["text", "foo"], { cwd: ws, env });
    expect(third.stdout.equals(coldRef.stdout)).toBe(true);
    expect(third.stderr.equals(coldRef.stderr)).toBe(true);
    expect(third.status).toBe(coldRef.status);

    for (const r of await Promise.all([a, b])) {
      expect(r.stdout.equals(slowCold.stdout)).toBe(true);
      expect(r.status).toBe(slowCold.status);
    }
    // Only the two slow calls were answered by the daemon.
    expect((await info())!.served).toBe(2);
  }, 60_000);

  it("lets a request wait for the run in progress only briefly, and a hook call not at all", async () => {
    await startDaemon();
    const slow = slowRgEnv(30);
    const a = ix(["text", "slow"], { cwd: ws, env: slow });
    await until(async () => (await info())?.active || undefined, "the slow run to start");

    // Both finish -- cold, and exactly as cold -- while the slow run still holds the daemon.
    const readCold = await ix(["read", "a.ts"], { cwd: ws, env: { ...env, IX_DAEMON: "off" } });
    const read = await ix(["read", "a.ts"], { cwd: ws, env });
    expect(read.stdout.equals(readCold.stdout)).toBe(true);
    expect(read.status).toBe(readCold.status);
    const hookInput = JSON.stringify({ session_id: "q", tool_name: "Bash", cwd: ws, tool_input: { command: "true" } });
    const hookCold = await ix(["hook", "claude-post-edit"], { cwd: ws, env: { ...env, IX_DAEMON: "off" }, input: hookInput });
    const hook = await ix(["hook", "claude-post-edit"], { cwd: ws, env, input: hookInput });
    expect(hook.stdout.equals(hookCold.stdout)).toBe(true);
    expect(hook.status).toBe(0);
    const during = (await info())!;
    expect(during.active).toBe(true);
    expect(during.served).toBe(0);

    // A raw hook request is told busy at once rather than queued.
    const raw = await request(socket(), await runRequestFor(["hook", "claude-post-edit"]), 5000);
    expect(raw.kind === "reply" && raw.reply.status).toBe("busy");
    expect((await info())!.queued).toBe(0);
    await stopDaemon();
    await a;
  }, 60_000);

  it("abandons a run whose client has gone, as a caller's death would end a cold call", async () => {
    await startDaemon();
    const slow = slowRgEnv(30);
    // The client gives up after 300 ms and closes its connection.
    const gone = await request(socket(), await runRequestFor(["text", "slow"], { PATH: slow.PATH! }), 300);
    expect(gone.kind).toBe("failed");
    // The run, and its `rg`, are stopped well before rg's 30 s.
    await until(async () => (await info())?.active === false || undefined, "the abandoned run to end", 10_000);
    expect(logText()).toMatch(/run text fallback=client-gone/);
  }, 30_000);

  it("runs the hook's deadline from when the caller started, not from its turn in the daemon", async () => {
    await startDaemon();
    const stdin = Buffer.from(JSON.stringify({ session_id: "d", tool_name: "Bash", cwd: ws })).toString("base64");
    const raw = await request(socket(), await runRequestFor(
      ["hook", "claude-post-edit"], { IX_HOOK_DEBUG: "1" }, { startedAt: Date.now() - 10_000, stdin },
    ), 5000);
    expect(raw.kind === "reply" && raw.reply.status).toBe("ok");
    if (raw.kind !== "reply" || raw.reply.status !== "ok") return;
    expect(raw.reply.exitCode).toBe(0);
    const stderr = raw.reply.out.filter(([fd]) => fd === 2).map(([, b]) => Buffer.from(b, "base64").toString("utf8")).join("");
    const out = raw.reply.out.filter(([fd]) => fd === 1);
    expect(out).toEqual([]);
    // Its clock says the 10 s since the caller started, so the 3 s budget was gone.
    const elapsed = Number(/nothing in (\d+) ms/.exec(stderr)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
  }, 30_000);

  it("saves no hook session state for a run abandoned at its deadline, as the cold path does not", async () => {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
    writeFileSync(join(ws, "a.ts"), "function foo() { return 1; }\nexport const bar = foo;\n");
    await startDaemon();
    // A backend slower than the hook's budget: the call ends at its deadline.
    backend.delayMs = 1500;
    const stateDir = join(base, "hook-state");
    const hookEnv = { ...env, IX_HOOK_TIMEOUT_MS: "400", IX_HOOK_STATE_DIR: stateDir, IX_HOOK_DEBUG: "1" };
    const input = JSON.stringify({ session_id: "slow", tool_name: "Edit", cwd: ws, tool_input: { file_path: join(ws, "a.ts") } });
    const states = () => (existsSync(stateDir) ? readdirSync(stateDir).map((f) => readFileSync(join(stateDir, f), "utf8")) : []);

    const cold = await ix(["hook", "claude-post-edit"], { cwd: ws, env: { ...hookEnv, IX_DAEMON: "off" }, input });
    expect(cold.stdout.length).toBe(0);
    expect(cold.stderr.toString("utf8")).toMatch(/no answer within/);
    await sleep(2000);
    const coldStates = states();
    expect(coldStates.join("")).not.toMatch(/fingerprint/);

    const before = (await info())!.served;
    const warm = await ix(["hook", "claude-post-edit"], { cwd: ws, env: hookEnv, input });
    expect((await info())!.served).toBe(before + 1);
    expect(warm.stdout.length).toBe(0);
    expect(warm.status).toBe(0);
    expect(warm.stderr.toString("utf8")).toMatch(/no answer within/);
    // Long after the backend has answered the abandoned work: still no state.
    await sleep(2000);
    expect(states()).toEqual(coldStates);

    // So the next call looks at the diff again rather than calling it reported.
    backend.delayMs = 0;
    const next = await ix(["hook", "claude-post-edit"], { cwd: ws, env: { ...hookEnv, IX_HOOK_TIMEOUT_MS: "5000" }, input });
    expect(next.stderr.toString("utf8")).not.toMatch(/diff unchanged since last report/);
  }, 60_000);

  it("answers only callers confined as it is", async () => {
    await startDaemon();
    const forged = await request(socket(), await runRequestFor(["read", "a.ts"], {}, { confinement: "some-other-sandbox" }), 5000);
    expect(forged.kind === "reply" && forged.reply).toEqual({ status: "fallback", reason: "confinement" });
    const missing = await request(socket(), await runRequestFor(["read", "a.ts"], {}, { confinement: undefined }), 5000);
    expect(missing.kind === "reply" && missing.reply).toEqual({ status: "fallback", reason: "confinement" });
  }, 30_000);

  it.skipIf(process.platform !== "linux" || ownConfinement.confined || !setpriv)(
    "never answers or starts for a caller under no_new_privs, as a sandboxed agent is",
    async () => {
      const sandboxed = (args: string[]) => new Promise<Result>((resolveRun, reject) => {
        const child = spawn(setpriv!, ["--no-new-privs", process.execPath, CLI, ...args], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        child.stdout!.on("data", (c: Buffer) => out.push(c));
        child.on("error", reject);
        child.on("close", (status) => resolveRun({ status, stdout: Buffer.concat(out), stderr: Buffer.alloc(0) }));
      });
      // No daemon yet: a sandboxed first call starts none.
      expect((await sandboxed(["read", "a.ts"])).status).toBe(0);
      await sleep(1000);
      expect(existsSync(socket())).toBe(false);
      // With one running, a sandboxed call still runs cold.
      const d = await startDaemon();
      const cold = await ix(["read", "a.ts"], { cwd: ws, env: { ...env, IX_DAEMON: "off" } });
      const call = await sandboxed(["read", "a.ts"]);
      expect(call.stdout.equals(cold.stdout)).toBe(true);
      expect((await info())!.served).toBe(d.served);
    },
    30_000,
  );

  it("steps aside for another build: answers stale, exits, and the call still succeeds cold", async () => {
    const first = await startDaemon();
    const raw = await request(socket(), {
      v: PROTOCOL_VERSION, kind: "run", build: "0.0.0+another-build", argv: ["text", "foo"], cwd: ws, env: {},
    }, 5000);
    expect(raw.kind === "reply" && raw.reply.status).toBe("stale");
    await until(() => !alive(first.pid) || undefined, "the stale daemon to exit");
    expect(logText()).toMatch(/exiting: another build/);
    const cold = await ix(["text", "foo"], { cwd: ws, env: { ...env, IX_DAEMON: "off" } });
    const call = await ix(["text", "foo"], { cwd: ws, env });
    expect(call.stdout.equals(cold.stdout)).toBe(true);
    expect(call.status).toBe(cold.status);
    // ... and that call started the next one.
    const next = await until(info, "a new daemon");
    expect(next.pid).not.toBe(first.pid);
  }, 30_000);

  it("exits after its idle time and removes its socket", async () => {
    const first = await startDaemon({ IX_DAEMON_IDLE_SECONDS: "1" });
    await until(() => !alive(first.pid) || undefined, "the idle daemon to exit");
    expect(existsSync(socket())).toBe(false);
    expect(logText()).toMatch(/exiting: idle/);
  }, 30_000);

  it("exits after its run ceiling, and after its memory ceiling", async () => {
    let d = await startDaemon({ IX_DAEMON_MAX_RUNS: "2" });
    await ix(["text", "foo"], { cwd: ws, env });
    expect(alive(d.pid)).toBe(true);
    await ix(["text", "foo"], { cwd: ws, env });
    await until(() => !alive(d.pid) || undefined, "the daemon to exit at its run ceiling");
    expect(logText()).toMatch(/exiting: ran 2 runs/);

    d = await startDaemon({ IX_DAEMON_MAX_RSS_MB: "1" });
    await ix(["text", "foo"], { cwd: ws, env });
    await until(() => !alive(d.pid) || undefined, "the daemon to exit at its memory ceiling");
    expect(logText()).toMatch(/exiting: rss \d+ bytes/);
  }, 60_000);

  it("`ix daemon status` and `ix daemon stop` report and stop it", async () => {
    const d = await startDaemon();
    const status = await ix(["daemon", "status", "--json"], { cwd: ws, env });
    expect(status.status).toBe(0);
    const parsed = JSON.parse(status.stdout.toString("utf8"));
    expect(parsed).toMatchObject({ running: true, enabled: true, pid: d.pid, build: d.build, socket: socket() });
    const text = await ix(["daemon", "status"], { cwd: ws, env });
    expect(text.stdout.toString("utf8")).toMatch(new RegExp(`^Ix daemon: running\\n  pid:     ${d.pid}\\n`));
    const stop = await ix(["daemon", "stop"], { cwd: ws, env });
    expect(stop.stdout.toString("utf8")).toBe(`Ix daemon: stopped (pid ${d.pid})\n`);
    expect(alive(d.pid)).toBe(false);
    const after = await ix(["daemon", "status", "--json"], { cwd: ws, env });
    expect(JSON.parse(after.stdout.toString("utf8"))).toMatchObject({ running: false });
    const again = await ix(["daemon", "stop"], { cwd: ws, env });
    expect(again.stdout.toString("utf8")).toBe("Ix daemon: not running\n");
    expect(again.status).toBe(0);
    const off = await ix(["daemon", "status"], { cwd: ws, env: { ...env, IX_DAEMON: "off" } });
    expect(off.stdout.toString("utf8")).toMatch(/^Ix daemon: not running \(IX_DAEMON=off: neither used nor started\)\n/);
  }, 30_000);

  it("is neither used nor started with IX_DAEMON=off", async () => {
    for (const v of ["off", "0"]) {
      const r = await ix(["text", "foo"], { cwd: ws, env: { ...env, IX_DAEMON: v } });
      expect(r.status).toBe(0);
    }
    await sleep(1000);
    expect(existsSync(socket())).toBe(false);
    expect(existsSync(dirname(socket()))).toBe(false);
  }, 20_000);
});

describe.skipIf(process.platform === "win32" || !built)("the client against a daemon that cannot answer", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let fake: NetServer | undefined;
  let requests: string[];

  const socketPath = () => daemonPaths({ IX_HOME: join(base, "h"), XDG_RUNTIME_DIR: join(base, "r") })!.socket;

  /** Listen where the daemon would, and answer every request with `answer`. */
  function fakeDaemon(answer: string | null, dirMode = 0o700): Promise<void> {
    const sock = socketPath();
    mkdirSync(dirname(sock), { recursive: true });
    chmodSync(dirname(sock), dirMode);
    fake = createNetServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString("utf8");
        if (!buf.includes("\n")) return;
        requests.push(buf.slice(0, buf.indexOf("\n")));
        if (answer !== null) c.end(answer);
      });
      c.on("error", () => {});
    });
    return new Promise((r) => fake!.listen(sock, () => r()));
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ixc-"));
    mkdirSync(join(base, "h"));
    mkdirSync(join(base, "r"));
    writeFileSync(join(base, "a.txt"), "hello daemon\n");
    requests = [];
    env = {
      ...process.env, IX_HOME: join(base, "h"), XDG_RUNTIME_DIR: join(base, "r"),
      IX_NO_UPDATE_CHECK: "1", IX_ENDPOINT: "http://127.0.0.1:1", IX_DAEMON_TIMEOUT_MS: "500",
      ...confinedOptIn,
    };
    delete env.IX_DAEMON;
    delete env.FORCE_COLOR;
    delete env.NODE_OPTIONS;
  });

  afterEach(async () => {
    if (fake) await new Promise((r) => fake!.close(r));
    fake = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  async function expectCold(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    const cold = await ix(args, { cwd: base, env: { ...env, ...extraEnv, IX_DAEMON: "off" } });
    const r = await ix(args, { cwd: base, env: { ...env, ...extraEnv } });
    expect(r.stdout.equals(cold.stdout), `${args.join(" ")}: stdout`).toBe(true);
    expect(r.stderr.equals(cold.stderr), `${args.join(" ")}: stderr`).toBe(true);
    expect(r.status).toBe(cold.status);
  }

  for (const [label, answer] of [
    ["busy", `{"status":"busy"}\n`],
    ["fallback", `{"status":"fallback","reason":"too-big"}\n`],
    ["stale", `{"status":"stale"}\n`],
    ["a malformed reply", "this is not json\n"],
    ["an ok reply with bad output", `{"status":"ok","exitCode":0,"out":[[3,"eA=="]]}\n`],
    ["no reply before the timeout", null],
  ] as const) {
    it(`runs cold on ${label}`, async () => {
      await fakeDaemon(answer);
      await expectCold(["read", "a.txt"]);
      await expectCold(["locate", "foo"]);
      expect(requests.length).toBe(2);
    }, 20_000);
  }

  it("sends argv, cwd, the environment and the build -- and stdin only for the invocations that read it", async () => {
    await fakeDaemon(`{"status":"busy"}\n`);
    await ix(["read", "a.txt"], { cwd: base, env: { ...env, IX_MARKER: "m1" }, input: "never read" });
    await ix(["hook", "claude-post-edit"], { cwd: base, env, input: '{"session_id":"x"}' });
    const [read, hook] = requests.map((l) => JSON.parse(l));
    expect(read).toMatchObject({ v: PROTOCOL_VERSION, kind: "run", argv: ["read", "a.txt"], cwd: base });
    expect(read.env.IX_MARKER).toBe("m1");
    expect(typeof read.build).toBe("string");
    expect(read.stdin).toBeUndefined();
    expect(read.confinement).toBe(ownConfinement.key);
    expect(typeof read.startedAt).toBe("number");
    expect(Buffer.from(hook.stdin, "base64").toString("utf8")).toBe('{"session_id":"x"}');
  }, 20_000);

  it("writes an ok reply's output in order, byte for byte, and exits with its code", async () => {
    const out = [[1, Buffer.from("one\n").toString("base64")], [2, Buffer.from([0xff, 0xfe, 0x0a]).toString("base64")], [1, Buffer.from("two\n").toString("base64")]];
    await fakeDaemon(`${JSON.stringify({ status: "ok", exitCode: 3, out })}\n`);
    const r = await ix(["locate", "foo"], { cwd: base, env });
    expect(r.stdout.toString("utf8")).toBe("one\ntwo\n");
    expect(r.stderr.equals(Buffer.from([0xff, 0xfe, 0x0a]))).toBe(true);
    expect(r.status).toBe(3);
  }, 20_000);

  it("never touches the daemon for IX_DAEMON=off, other commands, help, or Node flags", async () => {
    await fakeDaemon(`{"status":"busy"}\n`);
    await ix(["read", "a.txt"], { cwd: base, env: { ...env, IX_DAEMON: "off" } });
    for (const args of [["config", "show"], ["text", "--help"], ["nosuchcommand"], ["--version"], ["status"], ["daemon", "--help"]]) {
      await ix(args, { cwd: base, env });
    }
    await ix(["read", "a.txt"], { cwd: base, env: { ...env, NODE_OPTIONS: "--no-warnings" } });
    await ix(["read", "a.txt"], { cwd: base, env: { ...env, FORCE_COLOR: "1" } });
    expect(requests).toEqual([]);
  }, 30_000);

  it.skipIf(!ownConfinement.confined)("never talks to the daemon from a sandboxed process that has not opted in", async () => {
    await fakeDaemon(`{"status":"busy"}\n`);
    const sandboxedEnv = { ...env };
    delete sandboxedEnv.IX_DAEMON_ALLOW_CONFINED;
    await ix(["read", "a.txt"], { cwd: base, env: sandboxedEnv });
    await ix(["hook", "claude-post-edit"], { cwd: base, env: sandboxedEnv, input: "{}" });
    expect(requests).toEqual([]);
  }, 20_000);

  it("refuses a socket directory that group or others can write, and starts nothing there", async () => {
    await fakeDaemon(`{"status":"busy"}\n`, 0o770);
    await expectCold(["read", "a.txt"]);
    expect(requests).toEqual([]);
  }, 20_000);
});
