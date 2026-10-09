// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

// Two parse workers, as in ingest-equivalence.test.ts.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

/**
 * IN-11 cases the edit fixture cannot express: a file's exported names stay
 * the same but what they bind to changes -- an export alias pointed at another
 * local, a re-export moved to another module. The callers did not change, so
 * only the dependents pass can re-bind them.
 *
 * Each step writes files (null deletes) and runs an incremental map against
 * one fake backend; the CALLS edges left live must equal a fresh map's.
 */
type Files = Record<string, string | null>;
/** Files to write, and patch-source substrings the backend refuses during this map. */
type Step = Files | { files: Files; poison: string[] };

const ENV_KEYS = ["HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG"] as const;

async function liveVsFresh(steps: Step[], predicate: string): Promise<{ live: string[]; fresh: string[] }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-deps-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const backends: FakeBackend[] = [];
  let homes = 0;
  const start = async (): Promise<[FakeBackend, string, string]> => {
    const backend = new FakeBackend({ semantics: "head" });
    backends.push(backend);
    const home = join(root, `home${++homes}`);
    mkdirSync(home);
    return [backend, home, await backend.start()];
  };
  const map = (home: string, endpoint: string) => {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    return ingestFiles(repo, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true });
  };
  const edges = (backend: FakeBackend): string[] =>
    backend.graphSignature().edges
      .filter((line) => line.endsWith(` ${predicate}`))
      .map((line) => {
        const [, src, dst] = line.split(" ");
        // The target's id too: `x.foo` and `y.foo` share a name.
        return `${backend.nodeName(src!)} -> ${backend.nodeName(dst!)} ${dst}`;
      })
      .sort();
  try {
    const [backend, home, endpoint] = await start();
    for (const step of steps) {
      const files = "files" in step && typeof step.files === "object" ? (step.files as Files) : (step as Files);
      backend.poison = "poison" in step && Array.isArray(step.poison) ? step.poison : [];
      for (const [p, text] of Object.entries(files)) {
        const abs = join(repo, p);
        if (text === null) rmSync(abs);
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text, "utf8");
        }
      }
      execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
      await map(home, endpoint);
    }
    backend.poison = [];
    const [freshBackend, freshHome, freshEndpoint] = await start();
    await map(freshHome, freshEndpoint);
    return { live: edges(backend), fresh: edges(freshBackend) };
  } finally {
    for (const b of backends) await b.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("dependents re-bind when a name's target changes (IN-11)", () => {
  vi.setConfig({ testTimeout: 120_000 });
  const saved: Record<string, string | undefined> = {};
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
  });

  const caller = "import { foo } from './barrel';\nexport function go(): number { return foo(); }\n";

  it("an export alias pointed at another local re-binds its callers", async () => {
    const barrel = (local: string) =>
      `function a(): number { return 1; }\nfunction b(): number { return 2; }\nexport { ${local} as foo };\n`;
    const { live, fresh } = await liveVsFresh(
      [{ "web/barrel.ts": barrel("a"), "web/caller.ts": caller }, { "web/barrel.ts": barrel("b") }],
      "CALLS",
    );
    expect(fresh.map((e) => e.split(" ").slice(0, 3).join(" "))).toEqual(["go[function] -> b[function]"]);
    expect(live).toEqual(fresh);
  });

  it("a re-export moved to another module re-binds its callers", async () => {
    // CALLS only: the barrel's own retired IMPORTS edge is IN-04's (#808).
    const { live, fresh } = await liveVsFresh(
      [
        {
          "web/x.ts": "export function foo(): number { return 1; }\n",
          "web/y.ts": "export function foo(): number { return 2; }\n",
          "web/barrel.ts": "export { foo } from './x';\n",
          "web/caller.ts": caller,
        },
        { "web/barrel.ts": "export { foo } from './y';\n" },
      ],
      "CALLS",
    );
    expect(live).toEqual(fresh);
  });

  // A run that fails to send what it found leaves it for the next run: the
  // renamed file itself, or a caller it re-resolved.
  const math = (name: string) => `export function ${name}(): number { return 1; }\n`;
  const callsFoo = "import { foo } from './math';\nexport function go(): number { return foo(); }\n";

  it("a renamed file whose commit failed still re-binds its callers when it lands", async () => {
    const { live, fresh } = await liveVsFresh(
      [
        { "web/math.ts": math("bar"), "web/caller.ts": callsFoo },
        { files: { "web/math.ts": math("foo") }, poison: ["web/math.ts"] },
        {},
      ],
      "CALLS",
    );
    expect(fresh.map((e) => e.split(" ").slice(0, 3).join(" "))).toEqual(["go[function] -> foo[function]"]);
    expect(live).toEqual(fresh);
  });

  it("a caller whose re-send failed is re-sent by the next run", async () => {
    const { live, fresh } = await liveVsFresh(
      [
        { "web/math.ts": math("bar"), "web/caller.ts": callsFoo },
        { files: { "web/math.ts": math("foo") }, poison: ["web/caller.ts"] },
        {},
      ],
      "CALLS",
    );
    expect(fresh.map((e) => e.split(" ").slice(0, 3).join(" "))).toEqual(["go[function] -> foo[function]"]);
    expect(live).toEqual(fresh);
  });
});
