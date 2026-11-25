// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * Ix#1167. A workspace the stitcher joined into a system is mapped at system
 * scope, and a system-scoped map matches the system stamp on each row. Only a
 * complete map stitches (and stamps), so every patch an incremental map or a
 * single-file re-ingest sent wrote its rows with no system: each file it
 * touched dropped out of the system's map, until the map found no files. The
 * ingest now sends the workspace's system with every patch, without changing
 * any id.
 */

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS", "IX_PARSE_STREAM_CHUNK",
] as const;

describe("a stitched workspace's patches carry its system (Ix#1167)", () => {
  let root = "";
  let repo = "";
  const saved: Record<string, string | undefined> = {};
  const backends: FakeBackend[] = [];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-stitched-")));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(repo, "src", `f${i}.ts`), `export function f${i}(x: number): number { return x + ${i}; }\n`);
    }
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(async () => {
    for (const b of backends.splice(0)) await b.stop();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function start(stitchedSystem: string | null) {
    const backend = new FakeBackend({ semantics: "head" });
    backend.stitchedSystem = stitchedSystem;
    backend.rememberHashes = true;
    backends.push(backend);
    const endpoint = await backend.start();
    const home = join(root, `home-${backends.length}`);
    mkdirSync(home);
    return { backend, home, endpoint };
  }

  function map(world: { home: string; endpoint: string }) {
    process.env.HOME = world.home;
    process.env.USERPROFILE = world.home;
    process.env.IX_ENDPOINT = world.endpoint;
    process.env.IX_LOCK_DIR = join(world.home, "locks");
    return ingestFiles(repo, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true });
  }

  it("stamps every patch, fresh and incremental, and changes no patch id", async () => {
    const stitched = await start("a6e82e54");
    await map(stitched);
    expect(stitched.backend.sourceUris.length).toBeGreaterThan(0);
    expect(new Set(stitched.backend.sourceSystemIds)).toEqual(new Set(["a6e82e54"]));

    // The incremental map of one edited file -- the run that never stitches.
    appendFileSync(join(repo, "src", "f1.ts"), "export function extra(): number { return 1; }\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    const before = stitched.backend.sourceUris.length;
    await map(stitched);
    const sent = stitched.backend.sourceUris.slice(before);
    expect(sent).toEqual(["src/f1.ts"]);
    expect(stitched.backend.sourceSystemIds.slice(before)).toEqual(["a6e82e54"]);

    // The same tree into a backend that knows no system: the same patch ids,
    // and no system sent.
    const plain = await start(null);
    await map(plain);
    expect(new Set(plain.backend.sourceSystemIds)).toEqual(new Set([undefined]));
    expect(plain.backend.lastPatchIds).toEqual(stitched.backend.lastPatchIds);
  }, 120_000);
});
