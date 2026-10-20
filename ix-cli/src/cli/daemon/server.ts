// Copyright 2026 Ix Infrastructure Inc.

/**
 * The warm daemon: one per user per Ix home, started in the background by the
 * first agent-facing call that finds none (`daemon/client.ts`), and gone again
 * after a quiet spell. Nobody manages it; `ix daemon status` and
 * `ix daemon stop` are there to look at it.
 *
 * It answers one request at a time (`daemon/run.ts`) -- the commands share
 * process-wide state that cannot be made per request -- and holds at most one
 * more waiting, for at most `IX_DAEMON_QUEUE_WAIT_MS` (default 150). A request
 * beyond that, one that waits longer, and a hook call that would wait at all
 * are told `busy` and their clients run the call themselves: an agent's
 * parallel calls never queue behind each other, and the hook's deadline is
 * never spent in a queue.
 *
 * It exits, removing its socket, after `IX_DAEMON_IDLE_MINUTES` (default 15)
 * without a request, after `IX_DAEMON_MAX_RUNS` runs (default 1000), once its
 * RSS passes `IX_DAEMON_MAX_RSS_MB` (default 512), when a client of another
 * build reaches it, and on `ix daemon stop` or SIGTERM. The next call starts a
 * fresh one. Those settings are read from the environment it started with.
 *
 * It writes only to its log, `<IX_HOME>/daemon/daemon.log`, capped in size:
 * never to a terminal, and never a request's arguments or environment.
 */

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { pristineExit } from "../in-process.js";
import { OSS_COMMAND_TABLE } from "../register/oss-table.js";
import { request } from "./client.js";
import {
  computeBuildId,
  confinement,
  confinementAllows,
  DAEMON_COMMANDS,
  daemonPaths,
  ensureSecureDir,
  lineReader,
  PROTOCOL_VERSION,
  type DaemonReply,
  type DaemonRequest,
  type RunRequest,
} from "./protocol.js";
import { abandonCurrent, chargeEscapedError, prepareRuns, runRequest } from "./run.js";

const LOG_MAX_BYTES = 1024 * 1024;
/** A run longer than this has hung; the daemon gives up on itself. */
const RUN_WATCHDOG_MS = 10 * 60_000;
/** How long a stopping daemon waits for the run in progress. */
const STOP_GRACE_MS = 5_000;

function numberFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const paths = daemonPaths(process.env);
if (!paths) pristineExit(0);
const { socket: socketPath, startLock, log: logPath, dir } = paths!;

const idleMs = process.env.IX_DAEMON_IDLE_SECONDS
  ? numberFromEnv("IX_DAEMON_IDLE_SECONDS", 900) * 1000
  : numberFromEnv("IX_DAEMON_IDLE_MINUTES", 15) * 60_000;
const maxRuns = numberFromEnv("IX_DAEMON_MAX_RUNS", 1000);
const maxRssBytes = numberFromEnv("IX_DAEMON_MAX_RSS_MB", 512) * 1024 * 1024;
/**
 * Longest a request waits for the one in progress. Running cold costs a
 * fresh process, ~30 ms more than an answer from here; a wait behind a slow
 * read can cost seconds.
 */
const queueWaitMs = numberFromEnv("IX_DAEMON_QUEUE_WAIT_MS", 150);

const build = computeBuildId();
const startedAt = new Date();

let logWrites = 0;
function log(message: string): void {
  try {
    if (logWrites++ % 100 === 0) {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      try {
        if (statSync(logPath).size > LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`);
      } catch { /* no log yet */ }
    }
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`, { mode: 0o600 });
  } catch { /* a log that cannot be written costs nothing but the log */ }
}

// An error escaping a command ends that call in its own process. Here it must
// not end the daemon: the run it belongs to is abandoned instead.
process.on("uncaughtException", (err) => {
  const charged = chargeEscapedError();
  log(`${charged ? "run" : "idle"} uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
});
process.on("unhandledRejection", (err) => {
  const charged = chargeEscapedError();
  log(`${charged ? "run" : "idle"} unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
});

let socketIno: number | undefined;
/** Remove the socket, if it is still ours and not a successor's. */
function removeSocket(): void {
  if (socketIno === undefined) return;
  try {
    if (statSync(socketPath).ino === socketIno) unlinkSync(socketPath);
  } catch { /* already gone */ }
  socketIno = undefined;
}
process.on("exit", removeSocket);

let server: Server | undefined;
let shuttingDown = false;
let running = false;
const waiting: Array<{ req: RunRequest; sock: Socket; timer: NodeJS.Timeout }> = [];
/** The connection of the run in progress. */
let activeSock: Socket | undefined;
let served = 0;
let fallbacks = 0;
let idleTimer: NodeJS.Timeout | undefined;

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`exiting: ${reason} (served=${served} fallbacks=${fallbacks})`);
  if (idleTimer) clearTimeout(idleTimer);
  // Off the socket first, so the next call starts a new daemon rather than
  // reaching this one on its way out.
  removeSocket();
  server?.close();
  for (const w of waiting.splice(0)) {
    clearTimeout(w.timer);
    reply(w.sock, { status: "fallback", reason: "stopping" });
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  const tick = () => {
    if (!running || Date.now() > deadline) pristineExit(0);
    else setTimeout(tick, 20);
  };
  // A moment for the last reply to leave.
  setTimeout(tick, 20);
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (running || waiting.length > 0) armIdle();
    else shutdown("idle");
  }, idleMs);
}

function reply(sock: Socket, body: DaemonReply): void {
  if (sock.destroyed) return;
  sock.end(`${JSON.stringify(body)}\n`);
}

async function pump(): Promise<void> {
  if (running) return;
  const next = waiting.shift();
  if (!next) return;
  clearTimeout(next.timer);
  if (next.sock.destroyed) {
    void pump();
    return;
  }
  running = true;
  activeSock = next.sock;
  const began = Date.now();
  const watchdog = setTimeout(() => {
    log(`run of ${next.req.argv[0]} hung for ${RUN_WATCHDOG_MS} ms`);
    pristineExit(1);
  }, RUN_WATCHDOG_MS);
  try {
    const outcome = await runRequest(next.req);
    if (outcome.kind === "ok") {
      served += 1;
      reply(next.sock, { status: "ok", exitCode: outcome.exitCode, out: outcome.out });
      log(`run ${next.req.argv[0]} exit=${outcome.exitCode} ms=${Date.now() - began}`);
    } else {
      fallbacks += 1;
      reply(next.sock, { status: "fallback", reason: outcome.reason });
      log(`run ${next.req.argv[0]} fallback=${outcome.reason} ms=${Date.now() - began}`);
    }
  } finally {
    clearTimeout(watchdog);
    running = false;
    activeSock = undefined;
  }
  armIdle();
  if (served + fallbacks >= maxRuns) return shutdown(`ran ${served + fallbacks} runs`);
  const rss = process.memoryUsage.rss();
  if (rss > maxRssBytes) return shutdown(`rss ${rss} bytes`);
  void pump();
}

function handle(sock: Socket, req: DaemonRequest): void {
  if (!req || typeof req !== "object" || req.v !== PROTOCOL_VERSION) {
    reply(sock, { status: "stale" });
    return shutdown("protocol mismatch");
  }
  if (req.kind === "status") {
    return reply(sock, {
      status: "info",
      pid: process.pid,
      build,
      startedAt: startedAt.toISOString(),
      uptimeMs: Date.now() - startedAt.getTime(),
      served,
      fallbacks,
      active: running,
      queued: waiting.length,
      rssBytes: process.memoryUsage.rss(),
      socket: socketPath,
    });
  }
  if (req.kind === "stop") {
    reply(sock, { status: "stopping", pid: process.pid });
    return shutdown("stop requested");
  }
  if (req.kind !== "run" || !Array.isArray(req.argv) || typeof req.cwd !== "string" || !req.env || typeof req.env !== "object") {
    return reply(sock, { status: "fallback", reason: "malformed" });
  }
  if (req.build !== build) {
    reply(sock, { status: "stale" });
    return shutdown("another build");
  }
  if (shuttingDown) return reply(sock, { status: "fallback", reason: "stopping" });
  if (!DAEMON_COMMANDS.has(req.argv[0] ?? "")) return reply(sock, { status: "fallback", reason: "command" });
  // One running and one waiting; anyone else runs the call themselves. The
  // hook's budget is a few seconds, all of it its own: it never waits.
  if (running && (waiting.length >= 1 || req.argv[0] === "hook")) return reply(sock, { status: "busy" });
  if (idleTimer) clearTimeout(idleTimer);
  const entry = {
    req,
    sock,
    timer: setTimeout(() => {
      const at = waiting.indexOf(entry);
      if (at === -1) return;
      waiting.splice(at, 1);
      reply(sock, { status: "busy" });
    }, queueWaitMs),
  };
  waiting.push(entry);
  void pump();
}

function onConnection(sock: Socket): void {
  let seen = false;
  const feed = lineReader((line) => {
    if (seen) return;
    seen = true;
    let req: DaemonRequest;
    try {
      req = JSON.parse(line) as DaemonRequest;
    } catch {
      return reply(sock, { status: "fallback", reason: "malformed" });
    }
    handle(sock, req);
  });
  sock.on("data", (chunk: Buffer) => {
    try { feed(chunk); } catch { sock.destroy(); }
  });
  sock.on("error", () => sock.destroy());
  // A client that gave up -- its own timeout, or killed -- takes its run with
  // it, as a caller's death would end a cold call.
  sock.on("close", () => {
    if (activeSock === sock) abandonCurrent("client-gone");
  });
}

/** Bind the socket 0600, unless a live daemon already holds it. */
async function listen(): Promise<boolean> {
  const bind = () => new Promise<Server | NodeJS.ErrnoException>((resolve) => {
    const s = createServer(onConnection);
    const previous = process.umask(0o177);
    s.once("error", (err: NodeJS.ErrnoException) => {
      process.umask(previous);
      resolve(err);
    });
    s.listen(socketPath, () => {
      process.umask(previous);
      resolve(s);
    });
  });
  let bound = await bind();
  if (bound instanceof Error && bound.code === "EADDRINUSE") {
    // A socket file is there. If something answers on it, that daemon serves;
    // if nothing does, it was left by one that died.
    const probe = await request(socketPath, { v: PROTOCOL_VERSION, kind: "status" }, 1000);
    if (probe.kind === "reply") return false;
    try { unlinkSync(socketPath); } catch { /* raced with its owner */ }
    bound = await bind();
  }
  if (bound instanceof Error) {
    log(`cannot listen on ${socketPath}: ${bound.code ?? bound.message}`);
    return false;
  }
  server = bound;
  try {
    chmodSync(socketPath, 0o600);
    socketIno = statSync(socketPath).ino;
  } catch { /* checked by the client's directory test either way */ }
  return true;
}

async function main(): Promise<void> {
  // Started from inside a sandbox (by a client that could not tell): it would
  // serve unconfined callers with the sandbox's access, and is not wanted.
  if (!confinementAllows(confinement(), process.env)) {
    log("refusing to run confined");
    try { unlinkSync(startLock); } catch { /* not ours to keep */ }
    pristineExit(0);
  }
  const insecure = ensureSecureDir(dir);
  if (insecure !== null) {
    log(`refusing ${dir}: ${insecure}`);
    pristineExit(0);
  }
  const listening = await listen();
  try { unlinkSync(startLock); } catch { /* not ours to keep */ }
  if (!listening) pristineExit(0);
  process.chdir("/");
  prepareRuns();
  log(`listening on ${socketPath} build=${build} idle=${idleMs}ms maxRuns=${maxRuns}`);
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  armIdle();
  // Load what the allowlisted commands need now, while nobody waits, so the
  // first request is as fast as the rest -- and so an upgrade on disk can
  // never mix into this build's modules mid-session.
  for (const name of DAEMON_COMMANDS) {
    try { await OSS_COMMAND_TABLE[name]?.(); } catch (err) { log(`preload ${name}: ${String(err)}`); }
  }
  try {
    await import("../hook/entry.js");
    await import("../hook/claude-post-edit.js");
  } catch (err) { log(`preload hook: ${String(err)}`); }
}

void main();
