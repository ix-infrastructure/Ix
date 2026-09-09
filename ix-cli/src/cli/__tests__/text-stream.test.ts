import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Command } from "commander";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<Record<string, unknown>>()), spawn,
}));
import { registerTextCommand } from "../commands/text.js";

function match(snippet = "needle") {
  return JSON.stringify({ type: "match", data: {
    path: { text: "sample.ts" }, line_number: 1, lines: { text: snippet },
  } }) + "\n";
}

describe("text ripgrep stream lifecycle", () => {
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    spawn.mockReturnValue(child);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit 1"); });
  });
  afterEach(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    vi.restoreAllMocks();
    spawn.mockReset();
  });
  function run(limit = "2", format = "json") {
    const program = new Command();
    registerTextCommand(program);
    return program.parseAsync(["text", "needle", "--limit", limit, "--format", format], { from: "user" });
  }
  function close(code: number | null, signal: string | null = null) {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  }
  it("handles split UTF-8 records, ignores metadata, and drains until the child exits", async () => {
    const pending = run();
    const bytes = Buffer.from(match("日本語"));
    const split = bytes.indexOf(Buffer.from("日本")) + 1;
    child.stdout.write('{"type":"begin"}\nnot JSON\n');
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
    child.stdout.write(match("second") + match("third"));
    expect(child.kill).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    close(0);
    await pending;
    expect(JSON.parse(log.mock.calls[0][0]).map((r: { snippet: string }) => r.snippet)).toEqual(["日本語", "second"]);
    expect(spawn).toHaveBeenCalledWith("rg", expect.any(Array), { stdio: ["ignore", "pipe", "pipe"] });
  });
  it.each([0, 1])("accepts normal exit %s without killing below the limit", async code => {
    const pending = run();
    if (code === 0) child.stdout.write(match());
    close(code);
    await pending;
    expect(JSON.parse(log.mock.calls[0][0])).toHaveLength(code === 0 ? 1 : 0);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("accepts diagnostic stderr on a successful search", async () => {
    const pending = run("1");
    child.stdout.write(match());
    child.stderr.write("DEBUG globset: built glob set\n");
    close(0);
    await pending;
    expect(JSON.parse(log.mock.calls[0][0])).toHaveLength(1);
  });
  it.each(["text", "llm"])("preserves %s formatting", async format => {
    const pending = run("1", format);
    child.stdout.write(match());
    close(0);
    await pending;
    expect(log.mock.calls.flat().join("\n")).toContain("needle");
  });
  it.each(["stderr before limit", "stderr after limit", "exit 2", "unexpected signal"])("does not hide %s", async scenario => {
    const pending = run("1");
    const rejected = expect(pending).rejects.toThrow("exit 1");
    if (scenario === "stderr before limit") child.stderr.write("read error\n");
    child.stdout.write(match());
    if (scenario === "stderr after limit") child.stderr.write("read error\n");
    close(scenario === "unexpected signal" ? null : 2, scenario === "unexpected signal" ? "SIGKILL" : null);
    await rejected;
    expect(log).not.toHaveBeenCalled();
  });
  it("preserves the missing-ripgrep error", async () => {
    const pending = run();
    const rejected = expect(pending).rejects.toThrow("exit 1");
    child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    close(-2);
    await rejected;
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("is not installed"));
  });
});
