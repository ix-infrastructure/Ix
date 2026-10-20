// Copyright 2026 Ix Infrastructure Inc.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  coldReason,
  confinement,
  confinementAllows,
  daemonPaths,
  daemonStartEnv,
  ensureSecureDir,
  fnv1a64,
  insecureDirReason,
  lineReader,
  startupKey,
  stdinUse,
  type RouteInput,
} from "../daemon/protocol.js";
import { commandStdin, feedStdin } from "../stdin-source.js";
import { readStdin } from "../hook/io.js";
import { readIssueText } from "../explain/issue.js";
import { appendChunk, type ActiveRun } from "../in-process.js";

const agent = (args: string[], over: Partial<RouteInput> = {}): RouteInput => ({
  args,
  env: {},
  platform: "linux",
  stdoutIsTTY: false,
  stderrIsTTY: false,
  execArgv: [],
  ...over,
});

describe("which calls the daemon may answer", () => {
  it("answers every allowlisted read command from a non-interactive caller", () => {
    for (const word of ["text", "locate", "read", "explain", "callers", "search", "context", "impact", "around", "hook"]) {
      expect(coldReason(agent([word, "x"])), word).toBeNull();
    }
    expect(coldReason(agent(["hook", "claude-post-edit"]))).toBeNull();
    expect(coldReason(agent(["locate", "x"], { platform: "darwin" }))).toBeNull();
  });

  it("never on Windows", () => {
    expect(coldReason(agent(["locate", "x"], { platform: "win32" }))).toBe("platform");
  });

  it("never with IX_DAEMON=off", () => {
    for (const v of ["off", "OFF", "0", "false"]) {
      expect(coldReason(agent(["locate", "x"], { env: { IX_DAEMON: v } }))).toBe("disabled");
    }
    expect(coldReason(agent(["locate", "x"], { env: { IX_DAEMON: "on" } }))).toBeNull();
  });

  it("never when a terminal is attached to stdout or stderr", () => {
    expect(coldReason(agent(["locate", "x"], { stdoutIsTTY: true }))).toBe("tty");
    expect(coldReason(agent(["locate", "x"], { stderrIsTTY: true }))).toBe("tty");
  });

  it("never for a command outside the allowlist, help, version or an unknown word", () => {
    for (const args of [
      ["map"], ["watch"], ["mcp"], ["docker", "start"], ["ingest", "."], ["upgrade"], ["reset"], ["config", "show"],
      ["init"], ["daemon", "status"], ["status"], ["savings"], ["nosuchcommand"], ["--format", "json", "locate", "x"],
      [], ["--version"], ["help", "text"],
    ]) {
      expect(coldReason(agent(args)), args.join(" ")).toBe("command");
    }
    for (const flag of ["--help", "-h", "-V", "--version"]) {
      expect(coldReason(agent(["text", "foo", flag]))).toBe("help");
    }
    // After `--` it is a search term, not a flag; running cold is still safe.
    expect(coldReason(agent(["text", "--", "--help"]))).toBeNull();
  });

  it("never when colour could be on, since the daemon decided its colour once", () => {
    expect(coldReason(agent(["locate", "x"], { env: { FORCE_COLOR: "1" } }))).toBe("color");
    expect(coldReason(agent(["locate", "x"], { env: { FORCE_COLOR: "" } }))).toBe("color");
    expect(coldReason(agent(["locate", "x"], { env: { FORCE_COLOR: "0" } }))).toBeNull();
    expect(coldReason(agent(["locate", "x"], { env: { FORCE_COLOR: "false" } }))).toBeNull();
    expect(coldReason(agent(["locate", "x"], { env: { TF_BUILD: "1", AGENT_NAME: "a" } }))).toBe("color");
    expect(coldReason(agent(["locate", "x", "--color"]))).toBe("color");
    expect(coldReason(agent(["locate", "x", "--no-color"]))).toBe("color");
    expect(coldReason(agent(["locate", "x", "--color=256"]))).toBe("color");
  });

  it("never with Node flags, NODE_OPTIONS, inside `ix mcp`'s subprocess runner, or IX_LOAD_ALL_COMMANDS", () => {
    expect(coldReason(agent(["locate", "x"], { execArgv: ["--import", "x.mjs"] }))).toBe("node-options");
    expect(coldReason(agent(["locate", "x"], { env: { NODE_OPTIONS: "--max-old-space-size=100" } }))).toBe("node-options");
    expect(coldReason(agent(["locate", "x"], { env: { IX_MCP_CHILD: "1" } }))).toBe("mcp-child");
    expect(coldReason(agent(["locate", "x"], { env: { IX_LOAD_ALL_COMMANDS: "1" } }))).toBe("load-all");
  });
});

describe("what the daemon starts with", () => {
  it("keeps where things are and the start-up settings, and drops credentials", () => {
    const env = {
      HOME: "/home/u", PATH: "/bin", IX_HOME: "/h", XDG_RUNTIME_DIR: "/run/user/1", LANG: "en_US.UTF-8",
      LC_ALL: "C", NODE_EXTRA_CA_CERTS: "/ca.pem", IX_DAEMON_IDLE_MINUTES: "5",
      IX_TOKEN: "secret", GITHUB_TOKEN: "secret", AWS_SECRET_ACCESS_KEY: "secret", IX_ENDPOINT: "https://x", IX_FORMAT: "json",
    };
    expect(daemonStartEnv(env)).toEqual({
      HOME: "/home/u", PATH: "/bin", IX_HOME: "/h", XDG_RUNTIME_DIR: "/run/user/1", LANG: "en_US.UTF-8",
      LC_ALL: "C", NODE_EXTRA_CA_CERTS: "/ca.pem", IX_DAEMON_IDLE_MINUTES: "5",
    });
    // A caller and the daemon it started agree on the start-up settings.
    expect(startupKey(daemonStartEnv(env))).toBe(startupKey(env));
    expect(startupKey({ ...env, LANG: "C" })).not.toBe(startupKey(env));
    expect(startupKey({ ...env, IX_FORMAT: "llm" })).toBe(startupKey(env));
  });
});

describe("which invocations read stdin", () => {
  it("names exactly the hook and `context --from-issue -`", () => {
    expect(stdinUse(["hook", "claude-post-edit"])).toBe("hook");
    expect(stdinUse(["hook", "claude-post-edit", "--budget", "100"])).toBe("hook");
    expect(stdinUse(["context", "--from-issue", "-"])).toBe("all");
    expect(stdinUse(["context", "--format", "llm", "--from-issue=-"])).toBe("all");
    expect(stdinUse(["context", "--from-issue", "issue.md"])).toBe("none");
    expect(stdinUse(["context", "--", "--from-issue", "-"])).toBe("none");
    expect(stdinUse(["text", "-"])).toBe("none");
    expect(stdinUse(["locate", "x"])).toBe("none");
  });
});

describe("where the daemon lives", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ixd-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is one socket per resolved Ix home, under XDG_RUNTIME_DIR when there is one", () => {
    const a = daemonPaths({ IX_HOME: join(dir, "a"), XDG_RUNTIME_DIR: dir })!;
    const b = daemonPaths({ IX_HOME: join(dir, "b"), XDG_RUNTIME_DIR: dir })!;
    const a2 = daemonPaths({ IX_HOME: `${join(dir, "a")}/`, XDG_RUNTIME_DIR: dir })!;
    expect(a.dir).toBe(join(dir, "ix"));
    expect(a.socket).not.toBe(b.socket);
    expect(a2.socket).toBe(a.socket);
    expect(a.log).toBe(join(dir, "a", "daemon", "daemon.log"));
  });

  it("falls back to the Ix home's own state directory", () => {
    const p = daemonPaths({ IX_HOME: join(dir, "h") })!;
    expect(p.dir).toBe(join(dir, "h", "daemon"));
    expect(p.socket.startsWith(join(dir, "h", "daemon"))).toBe(true);
    // A relative XDG_RUNTIME_DIR is not one.
    expect(daemonPaths({ IX_HOME: join(dir, "h"), XDG_RUNTIME_DIR: "run" })!.dir).toBe(p.dir);
  });

  it("is not used when the socket path would be too long to bind", () => {
    expect(daemonPaths({ IX_HOME: join(dir, "x".repeat(120)) })).toBeNull();
  });

  it("names sockets with a stable hash", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
});

describe.skipIf(process.platform === "win32")("who may use the socket's directory", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ixd-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("creates it 0700 and accepts it", () => {
    const d = join(dir, "ix");
    expect(ensureSecureDir(d)).toBeNull();
    expect(insecureDirReason(d)).toBeNull();
  });

  it("refuses one that group or others can write", () => {
    const d = join(dir, "ix");
    mkdirSync(d);
    chmodSync(d, 0o770);
    expect(insecureDirReason(d)).toBe("writable by group or others");
    chmodSync(d, 0o703);
    expect(insecureDirReason(d)).toBe("writable by group or others");
    chmodSync(d, 0o755);
    expect(insecureDirReason(d)).toBeNull();
  });

  it("refuses a symlink and a missing directory", () => {
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(dir, "link"));
    expect(insecureDirReason(join(dir, "link"))).toBe("not a directory");
    expect(insecureDirReason(join(dir, "nope"))).toBe("missing");
  });

  it.skipIf(process.getuid?.() === 0)("refuses one owned by another user", () => {
    // `/` belongs to root on every machine this runs on.
    expect(insecureDirReason("/")).toBe("owned by another user");
  });
});

describe("the wire format", () => {
  it("splits lines across chunk boundaries", () => {
    const lines: string[] = [];
    const feed = lineReader((l) => lines.push(l));
    feed(Buffer.from('{"a":1}\n{"b"'));
    feed(Buffer.from(':2}\n'));
    feed(Buffer.from("partial"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("the stdin seam", () => {
  afterEach(() => feedStdin(undefined));

  it("is process.stdin until something is fed", () => {
    expect(commandStdin()).toBe(process.stdin);
  });

  it("hands the hook and `--from-issue -` the fed bytes, exactly", async () => {
    const bytes = Buffer.from('{"session_id":"s","tool_name":"Bash","cwd":"/tmp"}\n', "utf8");
    feedStdin(bytes);
    expect(await readStdin(1000)).toBe(bytes.toString("utf8"));
    feedStdin(Buffer.from("Fix the widget ✓", "utf8"));
    expect(await readIssueText("-")).toBe("Fix the widget ✓");
  });

  it("ends at once when what was fed is empty", async () => {
    feedStdin(Buffer.alloc(0));
    expect(await readStdin(5000)).toBe("");
    feedStdin(Buffer.alloc(0));
    expect(await readIssueText("-")).toBe("");
  });
});

describe("capturing a run's output as bytes", () => {
  const rawRun = (maxBytes: number): ActiveRun => ({
    stdout: [], stderr: [], raw: [], bytes: 0, maxBytes, truncated: false, closed: false,
  });

  it("keeps every chunk's exact bytes, stdout and stderr in the order written", () => {
    const run = rawRun(1024);
    appendChunk(run, "stdout", "one\n");
    appendChunk(run, "stderr", Buffer.from([0xff, 0xfe]));
    appendChunk(run, "stdout", "caf\u00e9", "latin1");
    expect(run.raw).toEqual([
      ["stdout", Buffer.from("one\n")],
      ["stderr", Buffer.from([0xff, 0xfe])],
      ["stdout", Buffer.from([0x63, 0x61, 0x66, 0xe9])],
    ]);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([]);
  });

  it("stops at the cap and marks the run truncated, so the daemon hands it back", () => {
    const run = rawRun(8);
    appendChunk(run, "stdout", "12345");
    appendChunk(run, "stdout", "67890");
    appendChunk(run, "stdout", "x");
    expect(run.truncated).toBe(true);
    expect(run.raw).toEqual([["stdout", Buffer.from("12345")]]);
  });
});

describe("the client's own weight", () => {
  it("loads nothing but Node built-ins before it knows whether the daemon answers", () => {
    // `main.ts` loads the client on every agent-facing call, before the CLI.
    const daemonDir = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon");
    for (const file of ["client.ts", "protocol.ts"]) {
      const src = readFileSync(join(daemonDir, file), "utf8");
      const statics = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
      expect(statics.length, file).toBeGreaterThan(0);
      for (const spec of statics) expect(spec, `${file} imports ${spec}`).toMatch(/^(node:|\.\/protocol\.js$)/);
    }
  });
});

describe("telling a sandboxed caller", () => {
  const status = (nnp: string, seccomp: string) => () =>
    `Name:\tnode\nNoNewPrivs:\t${nnp}\nSeccomp:\t${seccomp}\nSeccomp_filters:\t0\n`;
  const ns = (id: number) => (name: string) => `${name}:[${id}]`;

  it("counts no_new_privs as confined, and a seccomp filter alone (Docker's default) not", () => {
    expect(confinement("linux", status("0", "0"), ns(1)).confined).toBe(false);
    expect(confinement("linux", status("0", "2"), ns(1)).confined).toBe(false);
    expect(confinement("linux", status("1", "0"), ns(1)).confined).toBe(true);
    expect(confinement("linux", status("1", "2"), ns(1)).confined).toBe(true);
  });

  it("keys on namespaces, no_new_privs and the seccomp mode", () => {
    const base = confinement("linux", status("0", "0"), ns(1)).key;
    expect(confinement("linux", status("0", "0"), ns(1)).key).toBe(base);
    expect(confinement("linux", status("0", "0"), ns(2)).key).not.toBe(base);
    expect(confinement("linux", status("0", "2"), ns(1)).key).not.toBe(base);
    expect(confinement("linux", status("1", "0"), ns(1)).key).not.toBe(base);
  });

  it("treats a /proc it cannot read as confined", () => {
    expect(confinement("linux", () => { throw new Error("EACCES"); }, ns(1))).toEqual({ confined: true, key: "unknown" });
    expect(confinement("linux", () => "Name:\tnode\n", ns(1))).toEqual({ confined: true, key: "unknown" });
    expect(confinement("darwin")).toEqual({ confined: false, key: "darwin" });
  });

  it("lets a confined process use the daemon only when it opts in, and never when it cannot tell", () => {
    const confined = confinement("linux", status("1", "0"), ns(1));
    expect(confinementAllows(confined, {})).toBe(false);
    expect(confinementAllows(confined, { IX_DAEMON_ALLOW_CONFINED: "1" })).toBe(true);
    expect(confinementAllows({ confined: true, key: "unknown" }, { IX_DAEMON_ALLOW_CONFINED: "1" })).toBe(false);
    expect(confinementAllows(confinement("linux", status("0", "2"), ns(1)), {})).toBe(true);
  });
});
