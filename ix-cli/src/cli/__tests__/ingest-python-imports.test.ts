// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * Python calls through absolute imports, a package `__init__.py`, an aliased
 * module import and a typed receiver inside a method land on the imported
 * file, never on a same-named module elsewhere (`other/mod.py`). An edit that
 * changes an import, or what a package `__init__.py` defines, moves the edges
 * on the next incremental map exactly as a fresh map writes them.
 */

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS",
] as const;

type Sources = Record<string, string>;

const MODULE = (body: string) =>
  `def load(path):\n    return ${body}\n\n\nclass Query:\n    def where(self, clause):\n        return clause\n`;

const MAIN = (mod: string) => [
  "from pkg import entry",
  `from ${mod} import load, Query`,
  `import ${mod} as mod_alias`,
  "",
  "",
  "def read_config():",
  "    return load(\"config\")",
  "",
  "",
  "def read_alias():",
  "    return mod_alias.load(\"alias\")",
  "",
  "",
  "class Runner:",
  "    def run(self, q: Query):",
  "        entry()",
  "        return q.where(\"x\")",
  "",
].join("\n");

const BASE: Sources = {
  "pkg/__init__.py": "def entry():\n    return \"entry\"\n",
  "pkg/sub/__init__.py": "\"\"\"Sub package.\"\"\"\n",
  "pkg/sub/mod.py": MODULE("path"),
  "other/__init__.py": "\"\"\"Other package.\"\"\"\n",
  "other/mod.py": MODULE("path.upper()"),
  "app/__init__.py": "\"\"\"App.\"\"\"\n",
  "app/main.py": MAIN("pkg.sub.mod"),
};

describe("Python import resolution through a map (fake backend)", () => {
  vi.setConfig({ testTimeout: 120_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-python-imports-")));
  const saved: Record<string, string | undefined> = {};
  let run = 0;

  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function write(repoDir: string, sources: Sources): void {
    for (const [p, text] of Object.entries(sources)) {
      mkdirSync(dirname(join(repoDir, p)), { recursive: true });
      writeFileSync(join(repoDir, p), text, "utf8");
    }
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  }

  async function map(repoDir: string, home: string, endpoint: string): Promise<void> {
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await ingestFiles(repoDir, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true });
    } finally {
      stderr.mockRestore();
    }
  }

  /** Live cross-file CALLS edges as `caller@file -> callee@file`. */
  function calls(backend: FakeBackend): string[] {
    const fileOf = new Map<string, string>();
    for (const [uri, ops] of backend.lastOps) {
      for (const op of ops) if (op.type === "UpsertNode") fileOf.set(String(op.id), uri.replace(/\\/g, "/"));
    }
    const where = (id: string) => `${backend.nodeName(id).replace(/\[.*$/, "")}@${fileOf.get(id) ?? "?"}`;
    return backend.graphSignature().edges
      .map((line) => line.split(" "))
      .filter(([, src, dst, predicate]) => predicate === "CALLS" && fileOf.get(src!) !== fileOf.get(dst!))
      .map(([, src, dst]) => `${where(src!)} -> ${where(dst!)}`)
      .sort();
  }

  async function newRepo(): Promise<{ dir: string; repoDir: string }> {
    const dir = join(root, `run-${run++}`);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    return { dir, repoDir };
  }

  it("resolves each call to the imported file, not the same-named module", async () => {
    const { dir, repoDir } = await newRepo();
    const backend = new FakeBackend({ semantics: "head" });
    try {
      write(repoDir, BASE);
      await map(repoDir, join(dir, "home"), await backend.start());
      const edges = calls(backend);
      expect(edges).toEqual(expect.arrayContaining([
        "read_config@app/main.py -> load@pkg/sub/mod.py",
        "read_alias@app/main.py -> load@pkg/sub/mod.py",
        "run@app/main.py -> where@pkg/sub/mod.py",
        "run@app/main.py -> entry@pkg/__init__.py",
      ]));
      expect(edges.filter((e) => e.includes("other/mod.py"))).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  const EDITS: Array<[string, Sources, (edges: string[]) => void]> = [
    ["the importing file switches to the other module", { "app/main.py": MAIN("other.mod") }, (edges) => {
      expect(edges).toContain("read_config@app/main.py -> load@other/mod.py");
      expect(edges).toContain("run@app/main.py -> where@other/mod.py");
      expect(edges.filter((e) => e.includes("pkg/sub/mod.py"))).toEqual([]);
    }],
    ["the package __init__.py stops defining the imported name", { "pkg/__init__.py": "VERSION = 1\n" }, (edges) => {
      expect(edges.filter((e) => e.includes("pkg/__init__.py"))).toEqual([]);
      expect(edges).toContain("read_config@app/main.py -> load@pkg/sub/mod.py");
    }],
    ["a nearer pkg/sub/mod.py appears in the importing file's own root", { "app/pkg/sub/mod.py": MODULE("None") }, (edges) => {
      // app/ contains app/main.py and is deeper than the repo root.
      expect(edges).toContain("read_config@app/main.py -> load@app/pkg/sub/mod.py");
      expect(edges).toContain("read_alias@app/main.py -> load@app/pkg/sub/mod.py");
      expect(edges.filter((e) => e.includes("-> load@pkg/sub/mod.py"))).toEqual([]);
    }],
    ["a package pkg/sub/mod/ appears beside pkg/sub/mod.py", { "pkg/sub/mod/__init__.py": MODULE("None") }, (edges) => {
      // Module and package of one name under one root: ambiguous, no guess.
      expect(edges.filter((e) => e.startsWith("read_config@") || e.startsWith("read_alias@"))).toEqual([]);
    }],
  ];

  it.each(EDITS)("incremental equals fresh when %s", async (_name, edit, check) => {
    const { dir, repoDir } = await newRepo();
    const live = new FakeBackend({ semantics: "head" });
    const fresh = new FakeBackend({ semantics: "head" });
    try {
      const endpoint = await live.start();
      write(repoDir, BASE);
      await map(repoDir, join(dir, "home"), endpoint);
      const before = calls(live);

      write(repoDir, edit);
      await map(repoDir, join(dir, "home"), endpoint);
      await map(repoDir, join(dir, "fresh-home"), await fresh.start());
      expect(calls(fresh)).not.toEqual(before);
      check(calls(fresh));
      expect(calls(live)).toEqual(calls(fresh));
      expect(live.graphSignature()).toEqual(fresh.graphSignature());
    } finally {
      await live.stop();
      await fresh.stop();
    }
  });
});
