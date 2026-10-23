// Copyright 2026 Ix Infrastructure Inc.

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
  function matchAt(file: string, line: number) {
    return JSON.stringify({ type: "match", data: {
      path: { text: file }, line_number: line, lines: { text: `${file}:${line}` },
    } }) + "\n";
  }
  async function runArgs(argv: string[], records: string[]): Promise<string[]> {
    const program = new Command();
    registerTextCommand(program);
    const pending = program.parseAsync(["text", "--root", process.cwd(), ...argv], { from: "user" });
    for (const r of records) child.stdout.write(r);
    close(0);
    await pending;
    return log.mock.calls.map((c: unknown[]) => String(c[0]));
  }
  it("is byte-stable across arrival orders and keeps the best rows, not the first", async () => {
    // --limit 1 scans a window of 5; twelve matches overflow it, and the one
    // code match arrives last, after a full window of prose.
    const records = [
      ...Array.from({ length: 6 }, (_, i) => matchAt(`docs/d${i}.md`, i + 1)),
      ...Array.from({ length: 5 }, (_, i) => matchAt(`tests/t${i}.ts`, 1)),
      matchAt("src/code.ts", 7),
    ];
    const first = await runArgs(["needle", "--limit", "1", "--format", "json"], records);
    log.mockClear();
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    spawn.mockReturnValue(child);
    const second = await runArgs(["needle", "--limit", "1", "--format", "json"], [...records].reverse());
    expect(second).toEqual(first);
    expect(JSON.parse(first[0]).map((r: { path: string }) => r.path)).toEqual(["src/code.ts"]);
  });
  it("asks ripgrep for one match per file past --limit, to tell a full file from a cut-off one", async () => {
    await runArgs(["needle", "--limit", "5", "--format", "llm"], []);
    const argv = spawn.mock.calls[0][1] as string[];
    expect(argv.slice(0, argv.indexOf("--"))).toEqual(["--json", "--max-count", "6"]);
  });
  it("reports a file with more matches than ripgrep's per-file cap as a truncated scan", async () => {
    // --limit 5 caps each file at 5; the sixth match is ripgrep's probe and is not shown.
    const out = await runArgs(["needle", "--limit", "5", "--format", "llm"],
      Array.from({ length: 6 }, (_, i) => matchAt("src/a.ts", i + 1)));
    expect(out[0]).toBe("text shown=5 scanned=5 truncated=true");
    expect(out[1]).toContain("Narrow with --path or --language");
    expect(out.slice(2).map((l) => l.match(/line=(\d+)/)?.[1])).toEqual(["1", "2", "3", "4", "5"]);
  });
  it.each(["1", "5"])("does not call a file with exactly --limit %s matches truncated", async (limit) => {
    const n = Number(limit);
    const out = await runArgs(["needle", "--limit", limit, "--format", "llm"],
      Array.from({ length: n }, (_, i) => matchAt("src/a.ts", i + 1)));
    expect(out[0]).toBe(`text shown=${n} scanned=${n}`);
    expect(out.some((l) => l.startsWith("diagnostic"))).toBe(false);
  });
  it("pages inside the scan window and repeats --limit in the next command", async () => {
    const records = Array.from({ length: 5 }, (_, i) => matchAt(`src/f${i}.ts`, i + 1));
    const out = await runArgs(["needle", "--limit", "2", "--offset", "2", "--format", "llm"], records);
    expect(out[0]).toBe("text offset=2 shown=2 scanned=5 truncated=true");
    expect(out[1]).toContain("next_offset=4");
    expect(out[1]).toContain("next: ix text --limit 2 --format llm --root ");
    expect(out[1]).toMatch(/--offset 4 needle"$/);
    expect(out.slice(2).map((l) => l.match(/line=(\d+)/)?.[1])).toEqual(["3", "4"]);
  });
  it("pages past the first page's scan window: --offset widens the window", async () => {
    // --limit 1 scans 5 rows at offset 0. Twelve code matches, one per file.
    const records = Array.from({ length: 12 }, (_, i) => matchAt(`src/f${String(i).padStart(2, "0")}.ts`, 1));
    const out = await runArgs(["needle", "--limit", "1", "--offset", "7", "--format", "llm"], records);
    expect(out[0]).toBe("text offset=7 shown=1 scanned=12 truncated=true");
    expect(out[1]).toContain("next_offset=8");
    expect(out.slice(2).map((l) => l.match(/path=(\S+)/)?.[1])).toEqual(["src/f07.ts"]);
  });
  it("ranks a match record whose fields come in another order the same way", async () => {
    const reordered = JSON.stringify({ data: { line_number: 2, lines: { text: "late" }, path: { text: "src/a.ts" } }, type: "match" }) + "\n";
    const out = await runArgs(["needle", "--limit", "5", "--format", "json"], [matchAt("src/b.ts", 1), reordered, matchAt("src/a.ts", 1)]);
    expect(JSON.parse(out[0]).map((r: { path: string; line_start: number }) => `${r.path}:${r.line_start}`))
      .toEqual(["src/a.ts:1", "src/a.ts:2", "src/b.ts:1"]);
  });
  it("counts and names files whose paths are not UTF-8 (ripgrep sends them as bytes)", async () => {
    const bytesMatch = (raw: Buffer, line: number) => JSON.stringify({ type: "match", data: {
      path: { bytes: raw.toString("base64") }, line_number: line, lines: { text: "foo" },
    } }) + "\n";
    const a = Buffer.concat([Buffer.from("a"), Buffer.from([0xff]), Buffer.from(".txt")]);
    const b = Buffer.concat([Buffer.from("b"), Buffer.from([0xfe]), Buffer.from(".txt")]);
    const records = [1, 2, 3].flatMap((n) => [bytesMatch(a, n), bytesMatch(b, n)]).concat(matchAt("c.txt", 1));
    // Seven matches, at most three per file: under the per-file cap of 4, so nothing is cut.
    const out = await runArgs(["needle", "--limit", "4", "--format", "llm"], records);
    expect(out[0]).toBe("text shown=4 scanned=7 truncated=true");
    expect(out[1]).toContain("next_offset=4");
    expect(out.slice(2).map((l) => l.match(/path=(\S+) line=(\d+)/)?.slice(1).join(":")))
      .toEqual(["a�.txt:1", "a�.txt:2", "a�.txt:3", "b�.txt:1"]);
  });
  it("guards a term starting with a dash in the next command", async () => {
    const records = Array.from({ length: 5 }, (_, i) => matchAt(`src/f${i}.ts`, i + 1));
    const out = await runArgs(["--limit", "2", "--format", "llm", "--", "-x"], records);
    expect(out[1]).toMatch(/--offset 2 -- -x"$/);
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
