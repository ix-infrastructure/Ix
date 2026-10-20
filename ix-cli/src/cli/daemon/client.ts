// Copyright 2026 Ix Infrastructure Inc.

/**
 * The client half of the warm daemon: `main.ts` asks this, before it loads
 * anything else, whether the daemon can answer the call.
 *
 * A call the daemon answers costs one Node start, this module, and a round
 * trip on a Unix socket: no command modules, no config, no new backend
 * connection. Any call it cannot answer -- the rules are `coldReason` in
 * `protocol.ts` -- and any failure along the way (no daemon, a busy one, a
 * stale one, a malformed reply, a timeout) returns false, and `main.ts` runs
 * the call itself exactly as it always has. The daemon is a shortcut, never a
 * dependency.
 *
 * Node built-ins only, and nothing loaded that the answer does not need.
 */

import { closeSync, openSync, unlinkSync, writeSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import {
  coldReason,
  computeBuildId,
  confinement,
  confinementAllows,
  daemonPaths,
  daemonStartEnv,
  ensureSecureDir,
  insecureDirReason,
  lineReader,
  PROTOCOL_VERSION,
  stdinUse,
  type DaemonPaths,
  type DaemonReply,
  type DaemonRequest,
  type StdinUse,
} from "./protocol.js";

/** How long to wait for the daemon to accept the connection. */
const CONNECT_TIMEOUT_MS = 50;
/** How long a reply may take; a run that outlasts it is run again here. */
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
/** The hook's own deadline, as `hook/io.ts` reads it. */
const DEFAULT_HOOK_TIMEOUT_MS = 3000;
/** A start lock older than this belongs to a start that never finished. */
const START_LOCK_STALE_MS = 10_000;

/** What became of one attempt to reach the daemon. */
type Attempt =
  | { kind: "reply"; reply: DaemonReply }
  /** No daemon listening: start one. */
  | { kind: "absent" }
  | { kind: "failed" };

function hookTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.IX_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * How long past the hook's deadline to wait for the daemon's answer. The
 * daemon ends the run at that same deadline (it runs from the caller's start),
 * so this only covers the reply's trip back.
 */
const HOOK_REPLY_GRACE_MS = 500;

function replyTimeoutMs(env: NodeJS.ProcessEnv, use: StdinUse, hookDeadline: number): number {
  const raw = Number(env.IX_DAEMON_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (use === "hook") return Math.max(0, hookDeadline - Date.now()) + HOOK_REPLY_GRACE_MS;
  return DEFAULT_REPLY_TIMEOUT_MS;
}

/**
 * The caller's stdin, for the invocations that read it. The hook gives up on
 * stdin at its deadline, as `hook/io.ts` does; `undefined` then means "no
 * stdin in time".
 */
function readCallerStdin(use: StdinUse, hookDeadline: number): Promise<Buffer | undefined> {
  if (use === "hook" && isatty(0)) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const done = (value: Buffer | undefined) => {
      if (timer) clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.removeAllListeners("error");
      stdin.pause();
      // Nothing may keep this process alive on stdin's account any more.
      if (value === undefined) stdin.destroy();
      resolve(value);
    };
    if (use === "hook") timer = setTimeout(() => done(undefined), Math.max(0, hookDeadline - Date.now()));
    stdin.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stdin.on("end", () => done(Buffer.concat(chunks)));
    stdin.on("error", () => done(use === "hook" ? Buffer.alloc(0) : undefined));
  });
}

/** Send one request; the reply, "absent" when nothing listens, or "failed". */
export function request(socketPath: string, req: DaemonRequest, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const sock = connect(socketPath);
    const finish = (a: Attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(replyTimer);
      sock.destroy();
      resolve(a);
    };
    const connectTimer = setTimeout(() => finish({ kind: "failed" }), CONNECT_TIMEOUT_MS);
    let replyTimer: NodeJS.Timeout | undefined;
    sock.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      replyTimer = setTimeout(() => finish({ kind: "failed" }), timeoutMs);
      sock.write(`${JSON.stringify(req)}\n`);
    });
    const feed = lineReader((line) => {
      try {
        const reply = JSON.parse(line) as DaemonReply;
        finish(reply && typeof reply === "object" && typeof reply.status === "string"
          ? { kind: "reply", reply }
          : { kind: "failed" });
      } catch {
        finish({ kind: "failed" });
      }
    });
    sock.on("data", (chunk: Buffer) => {
      try { feed(chunk); } catch { finish({ kind: "failed" }); }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      const absent = !connected && (err.code === "ENOENT" || err.code === "ECONNREFUSED");
      finish(absent ? { kind: "absent" } : { kind: "failed" });
    });
    sock.on("close", () => finish({ kind: "failed" }));
  });
}

/** Write all of `bytes` to `fd`, waiting out a full non-blocking pipe. */
function writeAll(fd: number, bytes: Buffer): void {
  let off = 0;
  while (off < bytes.length) {
    try {
      off += writeSync(fd, bytes, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

/** Checked in full before a byte is written: a bad reply still runs cold. */
function wellFormed(out: unknown): out is Extract<DaemonReply, { status: "ok" }>["out"] {
  return Array.isArray(out) && out.every((c) =>
    Array.isArray(c) && c.length === 2 && (c[0] === 1 || c[0] === 2) && typeof c[1] === "string");
}

/** Replay the daemon's output in the order the command wrote it. */
function writeOutput(out: Extract<DaemonReply, { status: "ok" }>["out"]): void {
  const closed = new Set<number>();
  for (const [fd, b64] of out) {
    if (closed.has(fd)) continue;
    try {
      writeAll(fd, Buffer.from(b64, "base64"));
    } catch {
      // A reader that went away (`| head`) takes no more; the exit code stands.
      closed.add(fd);
    }
  }
}

/**
 * Start a daemon in the background, unless another call is already starting
 * one. Never waits for it: this call runs cold either way.
 */
async function startDaemon(paths: DaemonPaths): Promise<void> {
  if (ensureSecureDir(paths.dir) !== null) return;
  let fd: number;
  try {
    fd = openSync(paths.startLock, "wx", 0o600);
  } catch {
    // Someone is starting it. A lock left by a start that died is cleared for
    // the next call to retry, not this one: a race here could start two.
    try {
      if (Date.now() - statSync(paths.startLock).mtimeMs > START_LOCK_STALE_MS) unlinkSync(paths.startLock);
    } catch { /* gone already */ }
    return;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    const { spawn } = await import("node:child_process");
    const server = fileURLToPath(new URL("./server.js", import.meta.url));
    const child = spawn(process.execPath, [server], {
      detached: true,
      stdio: "ignore",
      cwd: "/",
      env: daemonStartEnv(process.env),
    });
    child.on("error", () => {
      try { unlinkSync(paths.startLock); } catch { /* the daemon took it */ }
    });
    child.unref();
  } catch {
    try { unlinkSync(paths.startLock); } catch { /* already gone */ }
  }
}

/**
 * Answer this call from the daemon if it can, writing its output and setting
 * `process.exitCode`. False means it did not, and the caller runs the call
 * itself -- with any stdin read here fed back through `stdin-source.ts`.
 */
export async function answerFromDaemon(args: string[]): Promise<boolean> {
  const startedAt = Date.now();
  // From source (tsx) there is no built server to start or to match.
  if (!import.meta.url.endsWith(".js")) return false;
  const env = process.env;
  const reason = coldReason({
    args,
    env,
    platform: process.platform,
    stdoutIsTTY: isatty(1),
    stderrIsTTY: isatty(2),
    execArgv: process.execArgv,
  });
  if (reason !== null) return false;
  // A sandboxed caller runs everything itself, and starts nothing: the daemon
  // would run its commands with the daemon's access instead of its own.
  const confined = confinement();
  if (!confinementAllows(confined, env)) return false;

  const paths = daemonPaths(env);
  if (!paths) return false;
  const insecure = insecureDirReason(paths.dir);
  if (insecure !== null && insecure !== "missing") return false;

  const use = stdinUse(args);
  // The hook's deadline runs from this call's start, as it does cold.
  const hookDeadline = startedAt + hookTimeoutMs(env);
  let stdin: Buffer | undefined;
  if (use !== "none") {
    stdin = await readCallerStdin(use, hookDeadline);
    // Read here, so no longer on the pipe: whoever runs the command reads it
    // from the seam.
    const { feedStdin } = await import("../stdin-source.js");
    feedStdin(stdin ?? Buffer.alloc(0));
    if (stdin === undefined) return false;
  }

  if (insecure === "missing") {
    await startDaemon(paths);
    return false;
  }

  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    // Deleted from under the caller: whatever the cold path makes of that.
    return false;
  }
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  const req: DaemonRequest = {
    v: PROTOCOL_VERSION,
    kind: "run",
    build: computeBuildId(),
    argv: args,
    cwd,
    env: cleanEnv,
    ...(process.argv[1] ? { entry: process.argv[1] } : {}),
    startedAt,
    confinement: confined.key,
    ...(stdin !== undefined ? { stdin: stdin.toString("base64") } : {}),
  };
  const attempt = await request(paths.socket, req, replyTimeoutMs(env, use, hookDeadline));
  if (attempt.kind === "absent") {
    await startDaemon(paths);
    return false;
  }
  if (attempt.kind !== "reply" || attempt.reply.status !== "ok") {
    // The hook's budget is spent: running it now would take as long again.
    // Its answer at the deadline is the one it gives cold -- nothing, exit 0.
    if (use === "hook" && Date.now() >= hookDeadline) {
      const { reportHookTimeout } = await import("../hook/entry.js");
      reportHookTimeout(startedAt, hookDeadline - startedAt);
      process.exitCode = 0;
      return true;
    }
    return false;
  }
  const { exitCode, out } = attempt.reply;
  if (!Number.isInteger(exitCode) || !wellFormed(out)) return false;
  writeOutput(out);
  process.exitCode = exitCode;
  return true;
}
