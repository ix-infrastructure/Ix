// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * A factory's return type (a Scala companion `apply`, a Go `NewX`) resolves in
 * the file that defines the factory: through its imports, its package and the
 * types visible there. A caller elsewhere types its receiver by that return
 * type. When only the defining file's imports change, or a type it can see
 * appears, the caller's typed edge must follow on the next incremental map, as
 * a fresh map would write it.
 *
 * Self-contained (no fast-check), so it runs where `ingest-equivalence` cannot.
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

const SCALA_BASE: Sources = {
  "other/Target.scala": "package other\nclass Target { def run() = () }\n",
  "third/Target.scala": "package third\nclass Target { def run() = () }\n",
  "app/Mk.scala": "package app\nimport other.Target\nobject Mk { def apply(): Target = new Target() }\n",
  "app/Use.scala": "package app\nobject Use { def use() = { val x = Mk(); x.run() } }\n",
};

const GO_BASE: Sources = {
  "go.mod": "module example.com/x\n\ngo 1.22\n",
  "other/target.go": "package other\n\ntype Target struct{}\n\nfunc (t Target) Run() {}\n",
  "third/target.go": "package third\n\ntype Target struct{}\n\nfunc (t Target) Run() {}\n",
  "app/mk.go": "package app\n\nimport m \"example.com/x/other\"\n\nfunc NewThing() m.Target { return m.Target{} }\n",
  "app/use.go": "package app\n\nfunc use() {\n\tx := NewThing()\n\tx.Run()\n}\n",
};

const SCENARIOS: Array<[string, Sources, Sources]> = [
  ["a Scala factory file changes only its import", SCALA_BASE,
    { "app/Mk.scala": "package app\nimport third.Target\nobject Mk { def apply(): Target = new Target() }\n" }],
  ["a Go factory file changes only its import path", GO_BASE,
    { "app/mk.go": "package app\n\nimport m \"example.com/x/third\"\n\nfunc NewThing() m.Target { return m.Target{} }\n" }],
  ["a type the Scala factory file can see appears in another file",
    {
      ...SCALA_BASE,
      "third/Target.scala": "package third\nclass Unrelated\n",
      "app/Mk.scala": "package app\nimport other._\nimport third._\nobject Mk { def apply(): Target = new Target() }\n",
    },
    { "third/Target.scala": "package third\nclass Target { def stop() = () }\n" }],
];

// Java: `get()` is declared by both URL and URI; only the caller's receiver
// type picks one. Every scenario edits a provider, never the caller.
const JAVA_TYPES: Sources = {
  "src/common/URL.java": "package common;\npublic class URL {\n  public String get() { return \"url\"; }\n}\n",
  "src/common/URI.java": "package common;\npublic class URI {\n  public String get() { return \"uri\"; }\n}\n",
};
const JAVA_INVOKER = (result: string, parent = "") =>
  `package rpc;\nimport common.URL;\nimport common.URI;\npublic interface Invoker${parent} {\n${result ? `  ${result} getUrl();\n` : ""}}\n`;

const JAVA_SCENARIOS: Array<[string, Sources, Sources]> = [
  ["a Java method's declared return type changes", {
    ...JAVA_TYPES,
    "src/rpc/Invoker.java": JAVA_INVOKER("URL"),
    "src/rpc/Use.java": "package rpc;\npublic class Use {\n  void use(Invoker invoker) {\n    invoker.getUrl().get();\n  }\n}\n",
  }, { "src/rpc/Invoker.java": JAVA_INVOKER("URI") }],
  ["an inherited Java method's declared return type changes", {
    ...JAVA_TYPES,
    "src/rpc/Base.java": JAVA_INVOKER("URL").replace("Invoker", "Base"),
    "src/rpc/Invoker.java": JAVA_INVOKER("", " extends Base"),
    "src/rpc/Use.java": "package rpc;\npublic class Use {\n  void use(Invoker invoker) {\n    invoker.getUrl().get();\n  }\n}\n",
  }, { "src/rpc/Base.java": JAVA_INVOKER("URI").replace("Invoker", "Base") }],
  ["a Java class changes its superclass", {
    ...JAVA_TYPES,
    "src/rpc/Sub.java": "package rpc;\nimport common.*;\npublic class Sub extends URL {\n}\n",
    "src/rpc/Use.java": "package rpc;\npublic class Use {\n  void use(Sub sub) {\n    sub.get();\n  }\n}\n",
  }, { "src/rpc/Sub.java": "package rpc;\nimport common.*;\npublic class Sub extends URI {\n}\n" }],
  ["a Java field changes its declared type", {
    ...JAVA_TYPES,
    "src/rpc/Holder.java": "package rpc;\nimport common.*;\npublic class Holder {\n  private URL target;\n  public String ping() {\n    return target.get();\n  }\n}\n",
    "src/rpc/Use.java": "package rpc;\npublic class Use {\n  void use(Holder holder) {\n    holder.ping();\n  }\n}\n",
  }, { "src/rpc/Holder.java": "package rpc;\nimport common.*;\npublic class Holder {\n  private URI target;\n  public String ping() {\n    return target.get();\n  }\n}\n" }],
  ["a same-package Java class appears and shadows an on-demand import", {
    ...JAVA_TYPES,
    "src/rpc/Use.java": "package rpc;\nimport common.*;\npublic class Use {\n  void use(URL url) {\n    url.get();\n  }\n}\n",
  }, { "src/rpc/URL.java": "package rpc;\npublic class URL {\n  public String get() { return \"rpc\"; }\n}\n" }],
];

describe("incremental map follows factory return types (fake backend)", () => {
  vi.setConfig({ testTimeout: 120_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-receiver-incremental-")));
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

  it.each(SCENARIOS)("%s", async (_name, base, edit) => {
    const dir = join(root, `run-${run++}`);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    const live = new FakeBackend({ semantics: "head" });
    const fresh = new FakeBackend({ semantics: "head" });
    try {
      const endpoint = await live.start();
      write(repoDir, base);
      await map(repoDir, join(dir, "home"), endpoint);
      const before = live.edgesOfTier("type");
      expect(before, "the caller's typed edge before the edit").toHaveLength(1);

      write(repoDir, edit);
      await map(repoDir, join(dir, "home"), endpoint);
      await map(repoDir, join(dir, "fresh-home"), await fresh.start());
      expect(fresh.edgesOfTier("type"), "the edit moves or drops the typed edge").not.toEqual(before);
      expect(live.edgesOfTier("type")).toEqual(fresh.edgesOfTier("type"));
      expect(live.graphSignature()).toEqual(fresh.graphSignature());
    } finally {
      await live.stop();
      await fresh.stop();
    }
  });

  it.each(JAVA_SCENARIOS)("%s", async (_name, base, edit) => {
    const dir = join(root, `run-${run++}`);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    const live = new FakeBackend({ semantics: "head" });
    const fresh = new FakeBackend({ semantics: "head" });
    try {
      const endpoint = await live.start();
      write(repoDir, base);
      await map(repoDir, join(dir, "home"), endpoint);
      const before = live.edgesOfTier("type");
      expect(before.length, "typed edges before the edit").toBeGreaterThan(0);

      write(repoDir, edit);
      await map(repoDir, join(dir, "home"), endpoint);
      await map(repoDir, join(dir, "fresh-home"), await fresh.start());
      expect(fresh.edgesOfTier("type"), "the edit moves a typed edge").not.toEqual(before);
      expect(live.edgesOfTier("type")).toEqual(fresh.edgesOfTier("type"));
      expect(live.graphSignature()).toEqual(fresh.graphSignature());
    } finally {
      await live.stop();
      await fresh.stop();
    }
  });
});
