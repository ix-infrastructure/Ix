// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * #967: an optional grammar that did not load left its files counted under
 * "skipped" with no language named. Here the Kotlin grammar is forced
 * unavailable -- core-ingestion's `grammarStatus()` is wrapped to report it
 * missing with a load error -- and a real ingest has to name it in its summary.
 */

const REASON = "Cannot find module 'tree-sitter-kotlin'";

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, ...rest] = await actual.loadIngestionModules();
      const grammarStatus = () => (ingestion.grammarStatus?.() ?? []).map((s) =>
        s.language === "kotlin" ? { ...s, loaded: false, reason: REASON } : s);
      return [{ ...ingestion, grammarStatus }, ...rest] as Awaited<ReturnType<typeof actual.loadIngestionModules>>;
    },
  };
});

const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS",
] as const;

describe("ingest summary with a grammar forced unavailable", () => {
  vi.setConfig({ testTimeout: 60_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-grammar-unavailable-")));
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
    rmSync(root, { recursive: true, force: true });
  });

  it("names the language, its file count and the load error", async () => {
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export function f(): number { return 1; }\n");
    writeFileSync(join(repo, "src", "B.kt"), "fun b() {}\n");
    writeFileSync(join(repo, "src", "C.kt"), "fun c() {}\n");
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });

    const backend = new FakeBackend();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = await backend.start();
    process.env.IX_LOCK_DIR = join(home, "locks");

    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let summary;
    try {
      summary = await ingestFiles(repo, { recursive: true, format: "text" });
    } finally {
      log.mockRestore();
      stderr.mockRestore();
      await backend.stop();
    }

    expect(summary.grammarUnavailable).toEqual([
      { language: "kotlin", files: 2, package: "tree-sitter-kotlin", reason: REASON },
    ]);
    // eslint-disable-next-line no-control-regex
    const text = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain(
      `grammar unavailable: kotlin: 2 files not parsed — grammar tree-sitter-kotlin did not load (${REASON})`,
    );
    // A language whose grammar loaded is never named.
    expect(text).not.toMatch(/grammar unavailable: typescript/);
  });
});
