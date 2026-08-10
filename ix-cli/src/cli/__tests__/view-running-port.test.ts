import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  createConnection: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: mocks.execSync,
  spawn: mocks.spawn,
}));

vi.mock("net", () => ({
  createConnection: mocks.createConnection,
}));

let ixHome: string;
let originalIxHome: string | undefined;

const pidFile = () => join(ixHome, "compass.pid");
const scopeFile = () => join(ixHome, "compass.scope");
const portFile = () => join(ixHome, "compass.port");
const serverScriptFile = () => join(ixHome, "tmp", "compass-server.js");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  originalIxHome = process.env.IX_HOME;
  ixHome = mkdtempSync(join(tmpdir(), "ix-view-port-test-"));
  process.env.IX_HOME = ixHome;

  const compassDir = join(ixHome, "cli", "compass");
  mkdirSync(compassDir, { recursive: true });
  writeFileSync(join(compassDir, "index.html"), "<!doctype html>");

  mocks.spawn.mockReturnValue({ pid: 4242, unref: vi.fn() });
  mocks.createConnection.mockImplementation(() => {
    const connection = new EventEmitter();
    queueMicrotask(() => connection.emit("error", new Error("not listening")));
    return connection;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(ixHome, { recursive: true, force: true });
  if (originalIxHome === undefined) {
    delete process.env.IX_HOME;
  } else {
    process.env.IX_HOME = originalIxHome;
  }
});

async function runView(args: string[]): Promise<string> {
  const { registerViewCommand } = await import("../commands/view.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerViewCommand(program);

  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    output.push(values.join(" "));
  });
  try {
    await program.parseAsync(["node", "ix", "view", ...args]);
  } finally {
    log.mockRestore();
  }
  return output.join("\n");
}

function seedRunningState(port?: number): void {
  writeFileSync(pidFile(), "4242");
  writeFileSync(scopeFile(), "*all*");
  if (port !== undefined) writeFileSync(portFile(), String(port));
}

describe("view running port state", () => {
  it("persists the port used to launch the visualizer", async () => {
    const output = await runView(["-p", "19123", "start", "--no-open", "--all"]);

    expect(readFileSync(portFile(), "utf-8")).toBe("19123");
    expect(output).toContain("http://localhost:19123");
  });

  it("reports the persisted port instead of a new requested port", async () => {
    seedRunningState(19123);
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["-p", "19124", "start", "--no-open", "--all"]);

    expect(output).toContain("Visualizer is already running (PID 4242)");
    expect(output).toContain("http://localhost:19123");
    expect(output).not.toContain("http://localhost:19124");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("recovers the running port from a pre-port-file server script", async () => {
    seedRunningState();
    mkdirSync(join(ixHome, "tmp"), { recursive: true });
    writeFileSync(serverScriptFile(), "const PORT = 19123;\n");
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["-p", "19124", "start", "--no-open", "--all"]);

    expect(output).toContain("http://localhost:19123");
    expect(readFileSync(portFile(), "utf-8")).toBe("19123");
  });

  it("does not print a requested port when legacy state cannot reveal the real one", async () => {
    seedRunningState();
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["-p", "19124", "start", "--no-open", "--all"]);

    expect(output).toContain("The running visualizer's port is unknown.");
    expect(output).not.toContain("http://localhost:19124");
  });

  it("removes port and scope state with a stale PID", async () => {
    seedRunningState(19123);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    const output = await runView(["status"]);

    expect(output).toContain("Visualizer is not running.");
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(scopeFile())).toBe(false);
    expect(existsSync(portFile())).toBe(false);
  });

  it("refuses to read an unreadable PID file as 'not running'", async () => {
    // A directory where the PID file belongs: present, but the read fails. Only
    // ENOENT means absent; anything else has to surface. Answering "not
    // running" here would delete a live server's only record, because both
    // callers of readAlivePid treat null as licence to act.
    mkdirSync(pidFile(), { recursive: true });
    writeFileSync(scopeFile(), "*all*");
    writeFileSync(portFile(), "19123");

    await expect(runView(["status"])).rejects.toThrow(/EISDIR|EPERM|EACCES/);

    expect(existsSync(scopeFile())).toBe(true);
    expect(existsSync(portFile())).toBe(true);
  });

  it("does not spawn a second server when the PID file is unreadable", async () => {
    // The sharper half of the same bug: swallowing the read error let `start`
    // run all the way to spawn(), and only then die writing the PID — leaving a
    // detached visualizer with nothing recording it, which `ix view stop` then
    // reports as not running and no later `ix view` can get past.
    mkdirSync(pidFile(), { recursive: true });

    await expect(
      runView(["start", "--no-open", "--all"]),
    ).rejects.toThrow(/EISDIR|EPERM|EACCES/);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("warns when the running instance is scoped to another workspace", async () => {
    // Nothing in the suite reached this branch before: every case seeded the
    // scope file as "*all*" and launched with --all, so the keys always matched
    // and the warning block never ran.
    writeFileSync(pidFile(), "4242");
    writeFileSync(scopeFile(), "some-other-workspace");
    writeFileSync(portFile(), "19123");
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["start", "--no-open", "--all"]);

    expect(output).toContain("It is scoped to");
    expect(output).toContain("rescope");
  });

  it("treats an empty scope file as unknown, not as a workspace named ''", async () => {
    // A start interrupted between opening and writing compass.scope leaves it
    // zero-length. Reading that as a scope makes every later `ix view` tell the
    // user to tear down an instance that is already scoped correctly.
    writeFileSync(pidFile(), "4242");
    writeFileSync(scopeFile(), "");
    writeFileSync(portFile(), "19123");
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["start", "--no-open", "--all"]);

    expect(output).not.toContain("It is scoped to");
  });

  it("removes persisted state when the visualizer stops", async () => {
    seedRunningState(19123);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["stop"]);

    expect(output).toContain("Visualizer stopped (PID 4242)");
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(scopeFile())).toBe(false);
    expect(existsSync(portFile())).toBe(false);
  });

  it("says the requested port was not honoured", async () => {
    seedRunningState(19123);
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["-p", "19124", "start", "--no-open", "--all"]);

    // Printing only the correct URL leaves the user believing -p moved the
    // server. It did not, and the difference is one digit.
    expect(output).toContain("You asked for port 19124");
    expect(output).toContain("it is serving on 19123");
  });

  it("stays quiet when no port was asked for", async () => {
    seedRunningState(19123);
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["start", "--no-open", "--all"]);

    expect(output).toContain("http://localhost:19123");
    expect(output).not.toContain("You asked for port");
  });

  it("reports the URL from status", async () => {
    seedRunningState(19123);
    vi.spyOn(process, "kill").mockReturnValue(true);

    expect(await runView(["status"])).toContain("http://localhost:19123");
  });

  it("says the port is unknown from status instead of printing nothing", async () => {
    seedRunningState();
    vi.spyOn(process, "kill").mockReturnValue(true);

    const output = await runView(["status"]);

    // Still no guessed URL — that is the bug #358 removed. But silence left
    // someone who ran status *for* the URL with nothing to act on, while
    // `ix view` in the identical state told them how to recover.
    expect(output).not.toContain("http://localhost");
    expect(output).toContain("unknown");
    expect(output).toContain("ix view stop");
  });
});

describe("runningInstanceLines", () => {
  it("never builds a URL from the requested port", async () => {
    const { runningInstanceLines } = await import("../commands/view.js");
    const lines = runningInstanceLines(19123, 19124, true);

    expect(lines[0]).toBe("  http://localhost:19123");
    expect(lines.some(l => l.includes("http://localhost:19124"))).toBe(false);
  });

  it("does not warn when the running port is the one that was asked for", async () => {
    const { runningInstanceLines } = await import("../commands/view.js");
    expect(runningInstanceLines(8080, 8080, true)).toEqual(["  http://localhost:8080"]);
  });

  it("admits it does not know rather than guessing", async () => {
    const { runningInstanceLines } = await import("../commands/view.js");
    const lines = runningInstanceLines(null, 8080, true);

    // A confidently wrong URL is the bug #358 removed; do not reintroduce it
    // through the warning path.
    expect(lines.some(l => l.includes("http://localhost"))).toBe(false);
    expect(lines.join("\n")).toContain("unknown");
  });
});
