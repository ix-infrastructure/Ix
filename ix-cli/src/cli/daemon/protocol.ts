// Copyright 2026 Ix Infrastructure Inc.

/**
 * What the warm daemon's client and server agree on: which calls it may
 * answer, where its socket lives, who may use it, and the wire format.
 *
 * Node built-ins only. The client loads this on every agent-facing `ix` call
 * before anything else, so whatever it imports is paid for by every call,
 * including the ones the daemon then does not answer.
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Bumped whenever a request or reply changes shape. */
export const PROTOCOL_VERSION = 1;

/**
 * The commands the daemon may answer: read-only and agent-facing. Everything
 * else -- `map`, `watch`, `mcp`, `docker`, `config`, Pro, help, unknown words
 * -- runs in its own process, as it always has.
 */
export const DAEMON_COMMANDS: ReadonlySet<string> = new Set([
  "text", "locate", "read", "explain", "callers", "search", "context", "impact", "around", "hook",
]);

/** `IX_DAEMON=off` turns the daemon off: it is neither used nor started. */
export const DAEMON_ENV = "IX_DAEMON";

/**
 * How a call's stdin reaches the command.
 *
 * - `none`: the command never reads it, so neither does the client. An
 *   inherited pipe may never close, and waiting on it would hang the call.
 * - `hook`: `ix hook claude-post-edit`, which reads it with a deadline.
 * - `all`: `ix context --from-issue -`, which reads it to the end.
 */
export type StdinUse = "none" | "hook" | "all";

/**
 * The invocations known to read stdin. A command that starts reading it must
 * be added here, or the daemon would hand it an empty stdin.
 */
export function stdinUse(args: readonly string[]): StdinUse {
  if (args[0] === "hook" && args[1] === "claude-post-edit") return "hook";
  if (args[0] === "context") {
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--") break;
      if (args[i] === "--from-issue=-" || (args[i] === "--from-issue" && args[i + 1] === "-")) return "all";
    }
  }
  return "none";
}

export interface RouteInput {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** Node's own flags for this process (`process.execArgv`). */
  execArgv: readonly string[];
}

/** Off for `off`, `0` and `false`. */
export function daemonDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env[DAEMON_ENV]?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/** A flag `supports-color` (chalk) reads off argv: `--color`, `--no-color=…`. */
const COLOR_FLAG = /^--(no-)?colou?rs?(=|$)/;

/**
 * Why this call must run in its own process, or null when the daemon may
 * answer it.
 *
 * Every rule is about one thing: the daemon must give the same bytes and exit
 * code the call would give on its own. Where that depends on something the
 * daemon's process does not share with the caller, the call runs cold.
 */
export function coldReason(input: RouteInput): string | null {
  const { args, env } = input;
  if (input.platform === "win32") return "platform";
  if (daemonDisabled(env)) return "disabled";
  // A person at a terminal: colour, progress, update notices, prompts.
  if (input.stdoutIsTTY || input.stderrIsTTY) return "tty";
  const word = args[0];
  if (word === undefined || !DAEMON_COMMANDS.has(word)) return "command";
  for (const a of args) {
    if (a === "--") break;
    if (a === "-h" || a === "--help" || a === "-V" || a === "--version") return "help";
    if (COLOR_FLAG.test(a)) return "color";
  }
  // Node flags or preloads (`--import`, `--inspect`) apply to this process,
  // and NODE_OPTIONS would apply to the daemon only as it was when it started.
  if (input.execArgv.length > 0 || (env.NODE_OPTIONS ?? "").trim() !== "") return "node-options";
  // chalk decides its colour level once, at import, from these. The daemon
  // imported it with them unset; a caller that forces colour gets its own.
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "0" && force !== "false") return "color";
  if (env.TF_BUILD !== undefined && env.AGENT_NAME !== undefined) return "color";
  // A child of `ix mcp`'s subprocess runner stays exactly what it was.
  if (env.IX_MCP_CHILD === "1") return "mcp-child";
  // The daemon only answers from the one-command registry.
  if (env.IX_LOAD_ALL_COMMANDS === "1") return "load-all";
  return null;
}

// ── What it starts with ────────────────────────────────────────────────────

/**
 * Settings a process reads once, as it starts, and never again: the locale
 * (ICU's default, which `localeCompare` sorts by), Node's and libuv's own
 * variables, OpenSSL's certificate paths and the proxy variables. The daemon
 * hands back a run whose values differ from the ones it started with, since
 * that run would not see its own.
 */
const STARTUP_ENV = /^(LANG|LANGUAGE|LC_[A-Z_]+|NODE_[A-Z0-9_]+|UV_[A-Z0-9_]+|SSL_CERT_(FILE|DIR)|OPENSSL_[A-Z_]+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/;

/** The values of {@link STARTUP_ENV}, comparable as one string. */
export function startupKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(Object.keys(env).filter((k) => STARTUP_ENV.test(k)).sort().map((k) => [k, env[k]]));
}

/** What the daemon's own environment keeps besides {@link STARTUP_ENV}. */
const START_ENV_KEEP = new Set(["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "IX_HOME", "XDG_RUNTIME_DIR"]);

/**
 * The environment the daemon starts with: where things are, the start-up
 * settings above, and its own `IX_DAEMON_*` settings -- nothing else. Each run
 * gets its caller's whole environment and gives it back when it ends, so a
 * token in the environment of the call that started the daemon (IX_TOKEN,
 * GITHUB_TOKEN, a cloud credential) is not kept for the daemon's lifetime.
 */
export function daemonStartEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (START_ENV_KEEP.has(k) || k.startsWith("IX_DAEMON_") || STARTUP_ENV.test(k)) out[k] = v;
  }
  return out;
}

// ── Who may ask ────────────────────────────────────────────────────────────

export interface Confinement {
  /**
   * Under a sandbox: no_new_privs is set (bubblewrap sets it, and Landlock
   * needs it, so Claude Code's and Codex's Linux sandboxes both have it), or
   * /proc could not be read to tell. A seccomp filter alone -- Docker's
   * default profile -- filters syscalls, not files, and does not count.
   */
  confined: boolean;
  /** The process's namespaces, no_new_privs and seccomp mode; equal keys, same confinement. */
  key: string;
}

/** `IX_DAEMON_ALLOW_CONFINED=1`: use the daemon even when confined, if the daemon is confined the same way. */
export const ALLOW_CONFINED_ENV = "IX_DAEMON_ALLOW_CONFINED";

const NAMESPACES = ["user", "mnt", "net", "pid", "ipc", "uts"];

/**
 * What confines this process, as far as it can tell cheaply.
 *
 * The daemon runs commands with its own access, not the caller's: a sandboxed
 * agent that asked it to `ix read` a file outside its sandbox would get the
 * file. So a confined caller neither uses the daemon nor starts one, and a run
 * is answered only for a caller whose key is the daemon's own -- same
 * namespaces, same no_new_privs, same seccomp mode. A request is the client's
 * word for this; a same-user process that can connect() to the socket can
 * claim anything, which only a sandbox that denies it the user's Unix sockets
 * (as it must for ssh-agent and D-Bus) can stop.
 *
 * Linux only: macOS offers no cheap way to tell a sandboxed process, so there
 * the key is the platform alone. `status` and `ns` are parameters for tests.
 */
export function confinement(
  platform: NodeJS.Platform = process.platform,
  status: () => string = () => readFileSync("/proc/self/status", "utf8"),
  ns: (name: string) => string = (name) => readlinkSync(`/proc/self/ns/${name}`),
): Confinement {
  if (platform !== "linux") return { confined: false, key: platform };
  try {
    const text = status();
    const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(text)?.[1];
    const nnp = field("NoNewPrivs");
    const seccomp = field("Seccomp");
    if (nnp === undefined || seccomp === undefined) return { confined: true, key: "unknown" };
    return { confined: nnp !== "0", key: JSON.stringify([nnp, seccomp, ...NAMESPACES.map((n) => ns(n))]) };
  } catch {
    return { confined: true, key: "unknown" };
  }
}

/** Whether a process confined as `c` may use or run the daemon, given its environment. */
export function confinementAllows(c: Confinement, env: NodeJS.ProcessEnv): boolean {
  return !c.confined || (env[ALLOW_CONFINED_ENV] === "1" && c.key !== "unknown");
}

// ── Where it lives ─────────────────────────────────────────────────────────

/** Longest socket path we bind: macOS allows 104 bytes, Linux 108. */
const MAX_SOCKET_PATH = 100;

export interface DaemonPaths {
  /** The resolved Ix home this daemon serves. */
  home: string;
  /** The 0700 directory holding the socket and the start lock. */
  dir: string;
  socket: string;
  /** Held by whoever is starting the daemon, so two first calls start one. */
  startLock: string;
  /** The daemon's log: under the Ix home, never a terminal. */
  log: string;
}

/**
 * FNV-1a, 64-bit, as hex. The socket's name only has to tell Ix homes apart,
 * not keep anything secret -- the directory's permissions do that -- and
 * `node:crypto` alone costs a few ms to load on every call.
 */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** `$IX_HOME`, else `~/.ix`, resolved, as `ix-home.ts` does. */
export function resolvedIxHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.IX_HOME || join(homedir(), ".ix"));
}

/**
 * One daemon per user per Ix home: named from a hash of the resolved home, so
 * a process with another `IX_HOME` -- a test, a benchmark, a sandbox -- never
 * shares one. Under `$XDG_RUNTIME_DIR/ix/` where there is one, else the Ix
 * home's own `daemon/`. Null when the socket path would be too long to bind.
 */
export function daemonPaths(env: NodeJS.ProcessEnv): DaemonPaths | null {
  const home = resolvedIxHome(env);
  const stateDir = join(home, "daemon");
  const id = fnv1a64(home);
  const runtime = env.XDG_RUNTIME_DIR;
  const dir = runtime && isAbsolute(runtime) ? join(runtime, "ix") : stateDir;
  const socket = join(dir, `${id}.sock`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) return null;
  return { home, dir, socket, startLock: join(dir, `${id}.start`), log: join(stateDir, "daemon.log") };
}

/**
 * Why `dir` may not hold our socket, or null when it may: it must be a real
 * directory (not a symlink), owned by this user, and writable by nobody else.
 * Anyone who can write there can put their own socket in its place and read
 * every request -- environment included.
 */
export function insecureDirReason(dir: string): string | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return "missing";
  }
  if (!st.isDirectory()) return "not a directory";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "owned by another user";
  if ((st.mode & 0o022) !== 0) return "writable by group or others";
  return null;
}

/** Create `dir` 0700 if missing; then the same check as {@link insecureDirReason}. */
export function ensureSecureDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return "cannot create";
  }
  return insecureDirReason(dir);
}

// ── Which build ────────────────────────────────────────────────────────────

/**
 * The installed CLI's identity: its version and the entry point's mtime and
 * size. A client and daemon with different ids are different builds, and the
 * daemon steps aside so an upgrade takes effect on the next call.
 *
 * Read from this module's own location, which the client and the server share
 * (`dist/cli/daemon/`), so both see the same files.
 */
export function computeBuildId(): string {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch { /* an unreadable package.json is still one build */ }
  let entry = "-";
  try {
    const st = statSync(new URL("../main.js", import.meta.url));
    entry = `${Math.trunc(st.mtimeMs)}-${st.size}`;
  } catch { /* running from source: the client does not use the daemon there */ }
  return `${version}+${entry}`;
}

// ── On the wire ────────────────────────────────────────────────────────────
//
// One JSON object per line each way, one request per connection. Byte
// payloads (stdin, output) are base64.

export interface RunRequest {
  v: number;
  kind: "run";
  build: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The caller's `process.argv[1]`, which commands that spawn `ix` again use. */
  entry?: string;
  /**
   * When the caller's `ix` started (epoch ms). The hook's deadline runs from
   * here, so time spent reaching the daemon comes out of its budget.
   */
  startedAt?: number;
  /** The caller's {@link confinement} key; a run is only answered when it is the daemon's own. */
  confinement?: string;
  /** Present only for invocations in {@link stdinUse}; base64. */
  stdin?: string;
}

export interface ControlRequest {
  v: number;
  kind: "status" | "stop";
}

export type DaemonRequest = RunRequest | ControlRequest;

/** 1 = stdout, 2 = stderr; base64 bytes, in the order they were written. */
export type OutputChunk = [1 | 2, string];

export type DaemonReply =
  | { status: "ok"; exitCode: number; out: OutputChunk[] }
  /** A run is in progress and one is already waiting. */
  | { status: "busy" }
  /** The daemon will not answer this call exactly; run it cold. */
  | { status: "fallback"; reason: string }
  /** Another build: the daemon is exiting. */
  | { status: "stale" }
  | {
      status: "info";
      pid: number;
      build: string;
      startedAt: string;
      uptimeMs: number;
      /** Runs answered from the daemon. */
      served: number;
      /** Runs it gave back to the client to run cold. */
      fallbacks: number;
      /** A run in progress, and how many wait behind it. */
      active: boolean;
      queued: number;
      rssBytes: number;
      socket: string;
    }
  | { status: "stopping"; pid: number };

/** Most a reply line may be: the output cap's base64, plus room. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Split a stream of bytes into lines, calling `onLine` with each. Returns the
 * feed function; it throws once a line exceeds {@link MAX_LINE_BYTES}.
 */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  let size = 0;
  return (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) break;
      parts.push(chunk.subarray(start, nl));
      const line = Buffer.concat(parts).toString("utf8");
      parts = [];
      size = 0;
      start = nl + 1;
      onLine(line);
    }
    if (start < chunk.length) {
      size += chunk.length - start;
      if (size > MAX_LINE_BYTES) throw new Error("line too long");
      parts.push(chunk.subarray(start));
    }
  };
}
