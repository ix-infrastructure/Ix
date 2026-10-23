// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * QA-07: a 5,000-file tree through one real `ingestFiles` run, with wall-time,
 * peak-RSS and request-count bounds.
 *
 * Slow on purpose: it runs under `npm run test:slow` (vitest.slow.config.ts)
 * and is excluded from `npm run test:unit` and coverage. It is not wired into
 * CI.
 *
 * The bounds are about 3x the value measured on the machine that wrote this
 * (see the constants), so they catch an order-of-magnitude regression -- a
 * per-file commit, a leak that holds every parse result -- without flaking on
 * a slower runner. RSS includes the parse pool's worker threads.
 */

const FILES = 5_000;
const DIRS = 50;
// Measured locally: wall 2.7 s, peak RSS growth 521 MB, 10 bulk requests. RSS
// and bulks are bounded at about 3x; wall is looser (30 s) because a CI runner
// is slower and the point is catching minutes, not seconds.
const MAX_WALL_MS = 30_000;
const MAX_RSS_GROWTH_BYTES = 1_500_000_000;
// The size and op caps split 5,000 files into 10 bulks. A per-file commit
// would be 5,000.
const MAX_BULKS = 30;

describe("ingestFiles at 5,000 files (QA-07)", () => {
  let home = "";
  let repo = "";
  let backend: FakeBackend | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    backend = new FakeBackend();
    home = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-scale-home-")));
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-scale-repo-")));
    const endpoint = await backend.start();
    for (const k of [
      "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_COMMIT_FAILURE_LIMIT",
      "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_MAX_OPS", "IX_COMMIT_CONCURRENCY",
      "IX_PARSE_WORKERS", "IX_DEBUG", "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS",
      "IX_MAP_DEADLINE_MS",
    ]) {
      // Cleared so an ambient value cannot move the bulk count or RSS under
      // test. It also means `IX_COMMIT_HTTP_MAX_FILES=1 npm run test:slow` does
      // not reach the run: to see the bulk bound fail, change the default in
      // ingest.ts (`parsePositiveIntEnv('IX_COMMIT_HTTP_MAX_FILES', 1000)`).
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
  });

  afterEach(async () => {
    try {
      if (backend) expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        await backend?.stop();
      } finally {
        for (const dir of [home, repo]) {
          if (!dir) continue;
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            process.stderr.write(`ingest-scale teardown: could not remove ${dir}: ${String(err)}\n`);
          }
        }
        home = "";
        repo = "";
      }
    }
  });

  it("finishes inside the wall-time and memory bounds, in a bounded number of requests", async () => {
    const dirOf = (i: number) => `pkg${String(i % DIRS).padStart(2, "0")}`;
    const nameOf = (i: number) => `f${String(i).padStart(4, "0")}`;
    for (let d = 0; d < DIRS; d++) mkdirSync(join(repo, `pkg${String(d).padStart(2, "0")}`), { recursive: true });
    for (let i = 0; i < FILES; i++) {
      // Every tenth file imports the one before it, so there are edges to resolve.
      const dep = i % 10 === 0 && i > 0 ? i - 1 : -1;
      const imp = dep >= 0 ? `import { ${nameOf(dep)} } from "../${dirOf(dep)}/${nameOf(dep)}.js";\n` : "";
      const call = dep >= 0 ? `${nameOf(dep)}() + ` : "";
      writeFileSync(
        join(repo, dirOf(i), `${nameOf(i)}.ts`),
        `${imp}export function ${nameOf(i)}(): number { return ${call}${i}; }\n`,
        "utf8",
      );
    }
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });

    const baseRss = process.memoryUsage().rss;
    let peakRss = baseRss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 100);
    const started = Date.now();
    try {
      await ingestFiles(repo, { format: "json", suppressOutput: true, printSummary: false });
    } finally {
      clearInterval(sampler);
    }
    const wallMs = Date.now() - started;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.stderr.write(`ingest-scale: wall=${wallMs}ms peakRssGrowth=${peakRss - baseRss}B bulks=${backend!.bulkCount}\n`);

    expect(wallMs, "wall time").toBeLessThan(MAX_WALL_MS);
    expect(peakRss - baseRss, "peak RSS growth").toBeLessThan(MAX_RSS_GROWTH_BYTES);
    expect(backend!.bulkCount, "bulk requests").toBeLessThanOrEqual(MAX_BULKS);
    expect(backend!.singleCount, "no per-file fallback").toBe(0);
    expect(backend!.unknownPaths).toEqual([]);

    const sent = new Map<string, number>();
    for (const uri of backend!.sourceUris) sent.set(uri, (sent.get(uri) ?? 0) + 1);
    expect(sent.size).toBe(FILES);
    expect([...sent.values()].filter(n => n !== 1)).toEqual([]);
  });
});
