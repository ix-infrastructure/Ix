// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerWithin, parseHookArgs, runPostEditHook, type EntryDeps } from "../hook/entry.js";
import { postToolUseOutput, withDeadline } from "../hook/io.js";
import { fingerprint, loadState, parseUnifiedDiff, pruneStates, statePath } from "../hook/session.js";
import { HOOK_CAPS, reportToolEdit, summarize, type PostToolUseInput } from "../hook/claude-post-edit.js";
import { estimateTokens, type AroundRequest, type AroundResult, type AroundSymbol } from "../around.js";
import { WorkspaceNotMappedError } from "../errors.js";

// ── Diff parsing ────────────────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -2 +2 @@ export function a() {",
    "-  return 1;",
    "+  return 2;",
    "@@ -10,0 +11,2 @@",
    "+x",
    "+y",
    "@@ -20,3 +21,0 @@",
    "-p",
    "-q",
    "-r",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+n",
    "diff --git \"a/src/sp\\303\\251cial.ts\" \"b/src/sp\\303\\251cial.ts\"",
    "--- \"a/src/sp\\303\\251cial.ts\"",
    "+++ \"b/src/sp\\303\\251cial.ts\"",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");

  it("reads each hunk's old side: replacements, insertion points and deletions", () => {
    const files = parseUnifiedDiff(diff);
    expect(files[0]).toEqual({
      oldPath: "src/a.ts", newPath: "src/a.ts",
      oldRanges: [{ start: 2, end: 2 }, { start: 10, end: 11, insertion: true }, { start: 20, end: 22 }],
    });
  });

  it("keeps a deleted file (its symbols had dependents) and a new file without an old path", () => {
    const files = parseUnifiedDiff(diff);
    expect(files[1]).toEqual({ oldPath: "src/gone.ts", newPath: undefined, oldRanges: [{ start: 1, end: 2 }] });
    expect(files[2].oldPath).toBeUndefined();
  });

  it("parses a quoted path", () => {
    expect(parseUnifiedDiff(diff)[3].oldPath).toBe("src/spécial.ts");
    expect(parseUnifiedDiff(diff)[3].newPath).toBe("src/spécial.ts");
  });

  it("does not take a removed `-- ` line or an added `++ ` line for a file header", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/q.py b/src/q.py",
      "--- a/src/q.py",
      "+++ b/src/q.py",
      "@@ -3,2 +3,2 @@",
      "--- select 1",
      "-x = 1",
      "+++ select 2",
      "+x = 2",
    ].join("\n"));
    expect(files).toEqual([{ oldPath: "src/q.py", newPath: "src/q.py", oldRanges: [{ start: 3, end: 4 }] }]);
  });
});

describe("parseHookArgs", () => {
  it("reads both flag spellings and ignores the rest", () => {
    expect(parseHookArgs(["--graph-root", "/g", "--worktree=/w", "--budget", "200", "--other"]))
      .toEqual({ graphRoot: "/g", worktree: "/w", budget: 200 });
    expect(parseHookArgs(["--budget", "abc"])).toEqual({});
  });
});

// ── The diff-based hook over a real git repository ──────────────────────────

const LIB = [
  "export function alpha(x) {", // 1
  "  return x + 1;", //            2
  "}", //                          3
  "", //                           4
  "export function beta(y) {", //  5
  "  return y * 2;", //            6
  "}", //                          7
  "", //                           8
  "export function gamma() {", //  9
  "  return 0;", //               10
  "}", //                         11
].join("\n");

const SYMBOLS: Array<[string, number, number]> = [["alpha", 1, 3], ["beta", 5, 7], ["gamma", 9, 11]];

/** The graph, mocked: every symbol whose span the ranges touch, unless excluded, with one caller. */
function fakeGather(calls: AroundRequest[], opts: { noDependents?: string[] } = {}) {
  return vi.fn(async (req: AroundRequest): Promise<AroundResult> => {
    calls.push(req);
    const symbols: AroundSymbol[] = SYMBOLS
      .filter(([name, s, e]) => !req.exclude?.has(name) && (req.ranges ?? []).some((r) => r.start <= e && r.end >= s))
      .map(([name, s, e]) => ({
        id: name, name, kind: "function", path: req.relPath, lineStart: s, lineEnd: e,
        callers: opts.noDependents?.includes(name)
          ? { total: 0, rows: [] }
          : { total: 1, rows: [{ path: "src/app.js", line: 3, snippet: `${name}(1);` }] },
        users: { total: 0, rows: [] }, tests: { total: 0, rows: [] }, sameName: [],
      }));
    return { path: req.relPath, symbols, importers: { total: 1, tests: 0, rows: [] } };
  });
}

let repo: string;
let stateDir: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ix-hook-repo-"));
  stateDir = mkdtempSync(join(tmpdir(), "ix-hook-state-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/lib.js"), LIB);
  writeFileSync(join(repo, "README.md"), "# r\n");
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const bash = (session = "s1"): string => JSON.stringify({
  session_id: session, hook_event_name: "PostToolUse", cwd: repo, tool_name: "Bash",
  tool_input: { command: "python3 - <<'E'\n...\nE" }, tool_response: { stdout: "", stderr: "" },
});

function deps(calls: AroundRequest[], over: Partial<EntryDeps> = {}): EntryDeps {
  return { gather: fakeGather(calls), chdir: () => {}, workspaceRoot: () => repo, ...over };
}

const run = (raw: string, d: EntryDeps) => runPostEditHook(raw, { env: { IX_HOOK_STATE_DIR: stateDir } }, d);
const context = (out: string | undefined) => JSON.parse(out!).hookSpecificOutput.additionalContext as string;
const edit = (from: string, to: string) => writeFileSync(join(repo, "src/lib.js"), LIB.replace(from, to));

describe("runPostEditHook: the diff path", () => {
  it("reports an edit made through Bash, located by the old side in HEAD's text", async () => {
    edit("  return y * 2;", "  const z = y * 2;\n  return z;");
    const calls: AroundRequest[] = [];
    const out = await run(bash(), deps(calls));
    expect(context(out)).toBe([
      "Ix: you changed `beta` (src/lib.js:5-7).",
      "callers (1):",
      "  src/app.js:3 beta(1);",
      "lib.js is imported by 1 file.",
      "These may need updating to match your edit.",
    ].join("\n"));
    expect(calls).toHaveLength(1);
    expect(calls[0].relPath).toBe("src/lib.js");
    expect(calls[0].ranges).toEqual([{ start: 6, end: 6 }]);
    expect(calls[0].anchorLines).toEqual(LIB.split("\n"));
    expect(calls[0].currentLines).toContain("  const z = y * 2;");
  });

  it("reports a symbol once per session, across repeated calls and repeat edits", async () => {
    const calls: AroundRequest[] = [];
    const d = deps(calls);
    edit("  return y * 2;", "  return y * 3;");
    expect(await run(bash(), d)).toBeDefined();
    // The same diff again: answered from the fingerprint, without the graph.
    expect(await run(bash(), d)).toBeUndefined();
    expect(calls).toHaveLength(1);
    // Editing the same function again: the graph is asked, the symbol excluded.
    edit("  return y * 2;", "  return y * 4;");
    expect(await run(bash(), d)).toBeUndefined();
    expect(calls[1].exclude).toEqual(new Set(["beta"]));
    // A newly edited function is reported.
    writeFileSync(join(repo, "src/lib.js"), LIB.replace("  return y * 2;", "  return y * 4;").replace("  return x + 1;", "  return x + 2;"));
    expect(context(await run(bash(), d))).toMatch(/^Ix: you changed `alpha`/);
  });

  it("keys its memory by session", async () => {
    edit("  return y * 2;", "  return y * 3;");
    const calls: AroundRequest[] = [];
    expect(await run(bash("s1"), deps(calls))).toBeDefined();
    expect(await run(bash("s1"), deps(calls))).toBeUndefined();
    expect(await run(bash("s2"), deps(calls))).toBeDefined();
    expect(statePath("s1", repo, { IX_HOOK_STATE_DIR: stateDir })).not.toBe(statePath("s2", repo, { IX_HOOK_STATE_DIR: stateDir }));
  });

  it("prints nothing, without loading the graph, for a Bash call that changed nothing", async () => {
    const calls: AroundRequest[] = [];
    const started = Date.now();
    expect(await run(bash(), deps(calls))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(0);
  });

  it("prints nothing for a new untracked file, or a changed non-code file", async () => {
    writeFileSync(join(repo, "src/fresh.js"), "export function fresh() {}\n");
    writeFileSync(join(repo, "README.md"), "# changed\n");
    const calls: AroundRequest[] = [];
    expect(await run(bash(), deps(calls))).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("locates deleted lines, and a deleted file", async () => {
    edit("  return 0;\n", "");
    const calls: AroundRequest[] = [];
    expect(context(await run(bash(), deps(calls)))).toMatch(/^Ix: you changed `gamma`/);
    expect(calls[0].ranges).toEqual([{ start: 10, end: 10 }]);

    unlinkSync(join(repo, "src/lib.js"));
    expect(context(await run(bash("s2"), deps(calls)))).toMatch(/`alpha`.*`beta`.*`gamma`/);
    expect(calls[1].currentLines).toEqual([""]);
  });

  it("remembers a symbol with nothing depending on it, without reporting it", async () => {
    writeFileSync(join(repo, "src/lib.js"), LIB.replace("x + 1", "x + 9").replace("y * 2", "y * 9").replace("return 0", "return 9"));
    const calls: AroundRequest[] = [];
    const out = context(await run(bash(), deps(calls, { gather: fakeGather(calls, { noDependents: ["gamma"] }) })));
    expect(out).toMatch(/`alpha`.*`beta`/s);
    expect(out).not.toMatch(/gamma/);
    expect(loadState(statePath("s1", repo, { IX_HOOK_STATE_DIR: stateDir })).reported.sort())
      .toEqual(["src/lib.js#alpha", "src/lib.js#beta", "src/lib.js#gamma"]);
  });

  it("caps the symbols per call and reports the rest on the next, even if nothing else changed", async () => {
    SYMBOLS.push(["delta", 1, 11]);
    try {
      writeFileSync(join(repo, "src/lib.js"), LIB.replace("x + 1", "x + 9").replace("y * 2", "y * 9").replace("return 0", "return 9"));
      const calls: AroundRequest[] = [];
      const first = context(await run(bash(), deps(calls)));
      expect(first).toMatch(/`alpha`.*`beta`.*`gamma`/s);
      expect(first).not.toMatch(/delta/);
      expect(context(await run(bash(), deps(calls)))).toMatch(/^Ix: you changed `delta`/);
      expect(await run(bash(), deps(calls))).toBeUndefined();
    } finally {
      SYMBOLS.pop();
    }
  });

  it("prints nothing when the backend is down, the workspace unmapped, or the file not in the graph", async () => {
    edit("  return y * 2;", "  return y * 3;");
    for (const err of [new TypeError("fetch failed"), new WorkspaceNotMappedError(repo), new Error("not in graph")]) {
      const out = await runPostEditHook(bash(`s-${err.message}`), { env: { IX_HOOK_STATE_DIR: stateDir } },
        { chdir: () => {}, workspaceRoot: () => repo, gather: vi.fn(async () => { throw err; }) });
      expect(out).toBeUndefined();
    }
  });

  it("prints nothing for input that is not JSON, or outside a mapped workspace", async () => {
    expect(await run("not json", deps([]))).toBeUndefined();
    edit("  return y * 2;", "  return y * 3;");
    expect(await run(bash(), deps([], { workspaceRoot: () => join(repo, "elsewhere") }))).toBeUndefined();
  });

  it("maps --worktree onto --graph-root", async () => {
    edit("  return y * 2;", "  return y * 3;");
    const calls: AroundRequest[] = [];
    const chdir = vi.fn();
    const out = await runPostEditHook(bash(), { graphRoot: "/graph", worktree: repo, env: { IX_HOOK_STATE_DIR: stateDir } },
      { ...deps(calls), chdir, workspaceRoot: () => "/graph" });
    expect(out).toBeDefined();
    expect(chdir).toHaveBeenCalledWith(resolve("/graph"));
    expect(calls[0].relPath).toBe("src/lib.js");
  });

  // git names the top level with links resolved; the roots the hook is handed
  // are as someone typed them. macOS's temp directory is such a link.
  it.skipIf(process.platform === "win32")("reports an edit in a checkout reached through a symlink", async () => {
    const link = `${repo}-link`;
    symlinkSync(repo, link, "dir");
    try {
      edit("  return y * 2;", "  return y * 3;");
      const calls: AroundRequest[] = [];
      const input = JSON.stringify({ ...JSON.parse(bash()), cwd: link });
      const out = await runPostEditHook(input, { env: { IX_HOOK_STATE_DIR: stateDir } },
        deps(calls, { workspaceRoot: () => link }));
      expect(context(out)).toMatch(/^Ix: you changed `beta`/);
      expect(calls[0].relPath).toBe("src/lib.js");
      // One checkout, one memory, whichever way it was reached.
      expect(statePath("s1", link, { IX_HOOK_STATE_DIR: stateDir }))
        .toBe(statePath("s1", repo, { IX_HOOK_STATE_DIR: stateDir }));
    } finally {
      unlinkSync(link);
    }
  });

  it("reads the diff whatever prefixes the user's git config asks for", async () => {
    git("config", "diff.mnemonicPrefix", "true");
    edit("  return y * 2;", "  return y * 3;");
    const calls: AroundRequest[] = [];
    expect(await run(bash(), deps(calls))).toBeDefined();
    expect(calls.map((c) => c.relPath)).toEqual(["src/lib.js"]);
  });

  it("stores the diff's fingerprint once everything in it was reported", async () => {
    edit("  return y * 2;", "  return y * 3;");
    await run(bash(), deps([]));
    const diff = execFileSync("git", ["-C", repo, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "HEAD", "--"], { encoding: "utf-8" });
    expect(loadState(statePath("s1", repo, { IX_HOOK_STATE_DIR: stateDir })).fingerprint).toBe(fingerprint(diff));
  });

  it("keeps its memory under IX_HOME, not in the shared temp directory", () => {
    const home = join(stateDir, "home");
    expect(dirname(statePath("s1", repo, { IX_HOME: home }))).toBe(join(home, "hook-state"));
    expect(dirname(statePath("s1", repo, { IX_HOME: home, IX_HOOK_STATE_DIR: stateDir }))).toBe(stateDir);
  });

  it("drops a session's file a week after its last write, and keeps the rest", () => {
    const fresh = join(stateDir, "fresh.json");
    const stale = join(stateDir, "stale.json");
    const other = join(stateDir, "notes.txt");
    for (const f of [fresh, stale, other]) writeFileSync(f, "{}");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stale, eightDaysAgo, eightDaysAgo);
    utimesSync(other, eightDaysAgo, eightDaysAgo);
    pruneStates(stateDir);
    expect(readdirSync(stateDir).sort()).toEqual(["fresh.json", "notes.txt"]);
  });
});

// ── Outside git: the Edit tool's own patch ──────────────────────────────────

describe("reportToolEdit (no git repository)", () => {
  const input: PostToolUseInput = {
    session_id: "s", cwd: "/ws", tool_name: "Edit",
    tool_input: { file_path: "/ws/src/lib.js", old_string: "  return y * 2;", new_string: "  return y * 3;" },
    tool_response: {
      originalFile: LIB,
      structuredPatch: [{ oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, lines: ["-  return y * 2;", "+  return y * 3;"] }],
    },
  };
  const d = (calls: AroundRequest[]) => ({
    gather: fakeGather(calls), chdir: () => {}, workspaceRoot: () => "/ws", readFile: () => LIB.replace("y * 2", "y * 3"),
  });

  it("reports from the old side of the tool's patch, and remembers what it reported", async () => {
    const calls: AroundRequest[] = [];
    const outcome = await reportToolEdit(input, new Set(), {}, d(calls));
    expect(context(outcome.output)).toMatch(/^Ix: you changed `beta` \(src\/lib\.js:5-7\)/);
    expect(calls[0].ranges).toEqual([{ start: 6, end: 6 }]);
    expect(outcome.reported).toEqual(["src/lib.js#beta"]);
  });

  it("prints nothing for a non-edit tool, a non-code file, or a symbol already reported", async () => {
    expect((await reportToolEdit({ ...input, tool_name: "Read" }, new Set(), {}, d([]))).output).toBeUndefined();
    expect((await reportToolEdit({ ...input, tool_input: { file_path: "/ws/README.md" } }, new Set(), {}, d([]))).output).toBeUndefined();
    expect((await reportToolEdit(input, new Set(["src/lib.js#beta"]), {}, d([]))).output).toBeUndefined();
  });
});

// ── Output ──────────────────────────────────────────────────────────────────

describe("output", () => {
  it("is exactly the PostToolUse shape", () => {
    expect(JSON.parse(postToolUseOutput("ctx"))).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "ctx" },
    });
  });

  it("stays under the token budget across several large files", () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({
      path: `src/some/deeply/nested/${p}${i}.ts`, line: 10 + i, snippet: `return await computeSomethingLong(${i}, alpha, beta, gamma);`,
    }));
    const results: AroundResult[] = ["a", "b"].map((f) => ({
      path: `src/${f}.ts`,
      symbols: ["x", "y"].map((name) => ({
        id: `${f}${name}`, name, kind: "function", path: `src/${f}.ts`, lineStart: 1, lineEnd: 9,
        callers: { total: 30, rows: many(8, `${f}${name}c`) }, users: { total: 6, rows: many(5, `${f}${name}u`) },
        tests: { total: 9, rows: many(5, `${f}${name}t`) }, sameName: [],
      })),
      importers: { total: 40, tests: 3, rows: many(5, `${f}i`) },
    }));
    const outcome = summarize(results, 300);
    expect(estimateTokens(context(outcome.output))).toBeLessThanOrEqual(300);
    expect(outcome.complete).toBe(false); // four symbols, three shown
    expect(outcome.reported).toEqual(["src/a.ts#ax", "src/a.ts#ay", "src/b.ts#bx"]);
  });

  it("drops an answer that misses the deadline", async () => {
    expect(await withDeadline(new Promise((r) => setTimeout(() => r("late"), 200)), 10)).toBeUndefined();
    expect(await withDeadline(Promise.reject(new Error("x")), 50)).toBeUndefined();
    expect(await withDeadline(Promise.resolve("ok"), 50)).toBe("ok");
  });
});

describe("the hook's row caps and its log", () => {
  it("asks for the hook's caps: the nearest two callers and users, one test", async () => {
    edit("  return y * 2;", "  return y * 3;");
    const calls: AroundRequest[] = [];
    await run(bash(), deps(calls));
    expect(calls[0].caps).toEqual(HOOK_CAPS);
    expect(HOOK_CAPS).toMatchObject({ callers: 2, users: 2, tests: 1 });
  });

  const logged = (file: string) => readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));

  it("logs one line per call saying why nothing was printed, or what was", async () => {
    const log = join(stateDir, "hook.log");
    const env = { IX_HOOK_STATE_DIR: stateDir, IX_HOOK_LOG: log };
    const calls: AroundRequest[] = [];
    await runPostEditHook(bash(), { env }, deps(calls)); // nothing changed yet
    edit("  return y * 2;", "  return y * 3;");
    await runPostEditHook(bash(), { env }, deps(calls)); // reports beta
    await runPostEditHook(bash(), { env }, deps(calls)); // same diff again
    const lines = logged(log);
    expect(lines.map((l) => l.path)).toEqual(["no_changes", "reported", "diff_unchanged"]);
    expect(lines[1].notes).toContain("src/lib.js#beta: reported");
    expect(lines[1].chars).toBeGreaterThan(0);
    expect(lines[1]).toMatchObject({ session: "s1", tool: "Bash", files: 1 });
    expect(typeof lines[1].ms).toBe("number");
  });

  it("logs a symbol with no dependents as the reason for silence", async () => {
    const log = join(stateDir, "hook.log");
    edit("  return y * 2;", "  return y * 3;");
    const calls: AroundRequest[] = [];
    const out = await runPostEditHook(bash(), { env: { IX_HOOK_STATE_DIR: stateDir, IX_HOOK_LOG: log } },
      deps(calls, { gather: fakeGather(calls, { noDependents: ["beta"] }) }));
    expect(out).toBeUndefined();
    const [line] = logged(log);
    expect(line.path).toBe("silent");
    expect(line.notes).toContain("src/lib.js#beta: no_dependents");
  });

  it("still says why on IX_HOOK_DEBUG when nothing changed", async () => {
    const said: string[] = [];
    await run(bash(), deps([], { debug: (m) => said.push(m) }));
    edit("  return y * 2;", "  return y * 3;");
    await run(bash(), deps([], { debug: (m) => said.push(m) }));
    await run(bash(), deps([], { debug: (m) => said.push(m) }));
    expect(said).toContain("no tracked changes");
    expect(said).toContain("diff unchanged since last report");
  });

  it("logs an edit inside a symbol it already reported as that, not as outside every definition", () => {
    const empty = { symbols: [], importers: { total: 0, tests: 0, rows: [] } };
    expect(summarize([{ path: "src/a.ts", ...empty, excluded: 1 }], 300).notes).toEqual(["src/a.ts: already_reported"]);
    expect(summarize([{ path: "src/a.ts", ...empty }], 300).notes).toEqual(["src/a.ts: no_definition_covers"]);
  });

  it("logs a call the deadline cut off", async () => {
    const log = join(stateDir, "hook.log");
    edit("  return y * 2;", "  return y * 3;");
    const never = vi.fn(() => new Promise<AroundResult>(() => {}));
    const out = await answerWithin(bash(), { env: { IX_HOOK_STATE_DIR: stateDir, IX_HOOK_LOG: log } }, 50,
      deps([], { gather: never }));
    expect(out).toBeUndefined();
    expect(never).toHaveBeenCalled();
    expect(logged(log).map((l) => l.path)).toEqual(["timeout"]);
  });

  it("writes no log without IX_HOOK_LOG", async () => {
    edit("  return y * 2;", "  return y * 3;");
    await run(bash(), deps([]));
    expect(() => readFileSync(join(stateDir, "hook.log"))).toThrow();
  });
});
