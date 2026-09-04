import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";

/**
 * Integration tests that drive `ingestFiles` end to end against a fake backend.
 *
 * They exist because that function is where every mechanical defect in Ix#560
 * and Ix#568 lived, and none of them were reachable from a unit test. The
 * decision tables were extracted (`perFileAction`, `drainInPasses`,
 * `createDrainGate`) and each extraction immediately caught a bug -- but the
 * WIRING between them stayed untested, and that is where the next one appeared
 * every time: a counter fed from the wrong place, a list the deadline diverted
 * to, a probe that treated proof as a failure.
 *
 * Nothing is mocked. `ingestFiles` builds its own `IxClient` from
 * `getEndpoint()`, which reads `IX_ENDPOINT`, so a real HTTP server on a
 * loopback port is the whole seam -- and the request log it keeps is exactly
 * the thing the PRs' measurements were about.
 *
 * What these catch, verified by restoring the bugs and watching them go red:
 *
 *   - removing the cutoff entirely (the pre-#560 fan-out);
 *   - the drain stopping on the first pass that placed nothing, which strands
 *     every good patch between two clusters of bad ones;
 *   - the stitch marker being cleared by a failure that is not proof, which is
 *     the #568 stacking itself.
 *
 * What they do NOT catch, and are not the right tool for: the finer stopping
 * rules inside `drainInPasses` -- two-empty-passes versus three, and the
 * direction flip. Those need a held set shaped precisely, which at this level
 * means contorting a fixture until it happens to produce one. They are
 * mutation-validated directly in `commit-breaker.test.ts`, and that division is
 * deliberate: coarse wiring here, decision tables there.
 */

/** A backend that answers the endpoints an ingest touches, and records them. */
class FakeBackend {
  readonly requests: Array<{ path: string; patches: number }> = [];

  private server: Server | undefined;
  private rev = 0;

  /** Patch-source substrings this backend refuses, whatever else is healthy. */
  poison: string[] = [];
  /** Fail every commit, the Ix#560 shape. */
  refuseEverything = false;
  /** Milliseconds to sit on each commit before answering. */
  commitDelayMs = 0;
  /** Refuse re-sends of patches a 409 already confirmed. */
  refuseReplays = false;
  /** Fired after `abortAfterCommits` commit requests, if set. */
  abortAfterCommits: number | undefined;
  private readonly aborter = new AbortController();

  /** A run deadline that fires at a known POINT IN THE COMMIT SEQUENCE. */
  get deadlineSignal(): AbortSignal {
    return this.aborter.signal;
  }
  /** Answer a bulk with 409 naming every patch as already committed. */
  bulk409AllLanded = false;
  /** Status for POST /v1/stitch. */
  stitchStatus = 200;

  get stitchCount(): number {
    return this.requests.filter(r => r.path === "/v1/stitch").length;
  }

  get bulkCount(): number {
    return this.requests.filter(r => r.path === "/v1/patches/bulk").length;
  }

  get singleCount(): number {
    return this.requests.filter(r => r.path === "/v1/patch").length;
  }

  get commitCount(): number {
    return this.bulkCount + this.singleCount;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      // Collect and concat, rather than `body += chunk`. Appending a Buffer to
      // a string decodes each TCP chunk on its own, so a multi-byte character
      // split across a chunk boundary is corrupted -- and a bulk body for
      // thirty patches is comfortably big enough to be split. Latent while the
      // fixtures are ASCII; the first non-ASCII one would make `JSON.parse`
      // throw and silently route the request down a different branch.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.route(req.url ?? "/", Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }

  private route(url: string, body: string, res: ServerResponse): void {
    const path = new URL(url, "http://x").pathname;
    const send = (code: number, payload: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/v1/patches/bulk" || path === "/v1/patch") {
      let patches: Array<{ patchId?: string }> = [];
      try {
        const parsed = JSON.parse(body) as { patches?: Array<{ patchId?: string }> };
        patches = parsed.patches ?? [parsed as { patchId?: string }];
      } catch {
        /* a body we cannot read is still a request */
      }
      this.requests.push({ path, patches: patches.length });
      if (this.abortAfterCommits !== undefined && this.commitCount >= this.abortAfterCommits) {
        this.aborter.abort();
      }

      if (path === "/v1/patch" && this.refuseReplays) {
        return send(500, { error: "500: already committed" });
      }
      if (path === "/v1/patches/bulk" && this.bulk409AllLanded) {
        const ids = patches.map(p => p.patchId).filter(Boolean);
        return send(409, { error: "bulk group partially committed", committed_patch_ids: ids });
      }
      const refused = this.refuseEverything || this.poison.some(p => body.includes(p));
      const answer = (): void => {
        if (refused) return send(500, { error: "500: transaction begin timeout" });
        this.rev += patches.length || 1;
        send(200, path === "/v1/patches/bulk" ? { rev: this.rev, applied: patches.length } : { rev: this.rev });
      };
      if (this.commitDelayMs > 0) setTimeout(answer, this.commitDelayMs);
      else answer();
      return;
    }

    if (path === "/v1/health") return send(200, { status: "ok", version: "1.0.28" });
    if (path === "/v1/source-hashes") return send(200, []);
    if (path.startsWith("/v1/stitch/system/")) return send(200, { systemId: null });
    if (path === "/v1/stitch") {
      this.requests.push({ path, patches: 0 });
      if (this.stitchStatus !== 200) return send(this.stitchStatus, { error: "AQL: query timed out" });
      return send(200, { stitched: 0, systemId: null, edges: [] });
    }
    return send(200, {});
  }
}

describe("ingestFiles against a fake backend", () => {
  let home: string;
  let repo: string;
  let backend: FakeBackend;
  const saved: Record<string, string | undefined> = {};

  /**
   * Write `count` trivially-parseable TypeScript files, in a KNOWN order.
   *
   * The `git init` + `git add` is load-bearing, not decoration. Discovery
   * prefers `git ls-files`, which sorts; with no repo it falls back to
   * `walkFiles`, which yields raw `readdirSync` order -- lexicographic on NTFS,
   * hash order on ext4 and APFS. The fixtures below are named for WHERE the
   * poison sits, and off Windows they would have quietly degenerated into the
   * scattered case on two of the five CI legs. The both-ends shape is the only
   * one that reproduces the drain's first-empty-pass bug, so losing it there
   * would have left that mutation uncaught precisely where nobody runs the
   * suite by hand.
   */
  function fixture(count: number): void {
    mkdirSync(join(repo, "src"), { recursive: true });
    for (let i = 0; i < count; i++) {
      const name = `m${String(i).padStart(3, "0")}.ts`;
      writeFileSync(join(repo, "src", name), `export function f${i}(): number { return ${i}; }\n`, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  }

  /** The order discovery will actually walk — asserted, never assumed. */
  function discoveryOrder(): string[] {
    return execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ix-ingest-home-"));
    repo = mkdtempSync(join(tmpdir(), "ix-ingest-repo-"));
    backend = new FakeBackend();
    const endpoint = await backend.start();

    // HOME *and* USERPROFILE: `os.homedir()` reads the latter on Windows, so
    // redirecting only HOME leaves the run writing its mtime cache and
    // baselines into the developer's real ~/.ix.
    // Saved AND cleared. Recording them was not enough: every one of these is
    // read straight from the environment, so a developer who has exported
    // `IX_COMMIT_FAILURE_LIMIT=0` -- the value the CLI's own failure banner
    // tells users to set -- turns the cutoff off and makes the bounded-request
    // assertions meaningless, and `IX_COMMIT_HTTP_MAX_FILES=1` breaks the
    // one-bulk assertion outright.
    for (const k of [
      "HOME",
      "USERPROFILE",
      "IX_ENDPOINT",
      "IX_LOCK_DIR",
      "IX_COMMIT_FAILURE_LIMIT",
      "IX_COMMIT_HTTP_MAX_FILES",
      "IX_COMMIT_CONCURRENCY",
      "IX_STITCH_COOLDOWN_MS",
      "IX_STITCH_WAIT_MS",
      "IX_MAP_DEADLINE_MS",
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
  });

  afterEach(async () => {
    await backend.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const run = () =>
    ingestFiles(repo, { format: "text", force: true, suppressOutput: true, printSummary: false });

  /**
   * A run that ends fatally. Under `suppressOutput` a fatal commit outcome is
   * raised rather than printed, so the caller sees it -- the assertion is on
   * the message and on what the backend was actually asked to do.
   */
  const runFatal = async (): Promise<string> => {
    try {
      await run();
    } catch (err) {
      return String(err);
    }
    throw new Error("expected the ingest to end fatally");
  };

  it("bounds the requests to a backend that refuses everything (Ix#560)", async () => {
    // The bug: one failed bulk became one doomed request per patch, each
    // waiting out its own timeout, against the database that is the reason
    // they fail. `main` sends 1 + N; the cutoff stops the fan-out after
    // IX_COMMIT_FAILURE_LIMIT and bounds the drain that follows.
    fixture(30);
    backend.refuseEverything = true;

    const message = await runFatal();

    expect(message, "every patch is accounted for, none silently dropped").toContain("30 of 30");
    expect(message).toContain("See the cutoff above");
    expect(backend.commitCount, "well under main's 31").toBeLessThan(25);
    expect(backend.commitCount, "and it still tried").toBeGreaterThan(1);
  });

  it("strands nothing a healthy backend would have taken (Ix#560)", async () => {
    // The invariant the whole drain design exists for, and the one four
    // successive stopping rules got wrong: on a backend refusing PARTICULAR
    // patches, the error count must equal the number of bad patches exactly.
    // Anything higher is a committable patch reported as failed without ever
    // being sent -- and since the mtime baseline is not written on a run with
    // commit errors, the next map repeats it forever.
    fixture(30);
    backend.poison = ["m005.ts", "m006.ts", "m007.ts", "m008.ts", "m009.ts"];

    const summary = await run();

    expect(summary.commitErrors).toBe(5);
    expect(summary.patchesApplied).toBe(25);
  });

  it("strands nothing when the bad patches sit at the very start", async () => {
    // The leading-cluster shape. The fan-out trips before anything succeeds,
    // so the drain has no evidence the backend is alive and must not guess
    // from a single empty pass.
    fixture(30);
    backend.poison = ["m000.ts", "m001.ts", "m002.ts", "m003.ts", "m004.ts", "m005.ts"];
    expect(discoveryOrder()[0], "the poison must actually come first").toContain("m000.ts");

    const summary = await run();

    expect(summary.commitErrors).toBe(6);
    expect(summary.patchesApplied).toBe(24);
  });

  it("strands nothing when bad patches sit at BOTH ends of the held set", async () => {
    // The shape that defeats every simpler stopping rule, and the reason the
    // drain samples three positions rather than one or two.
    //
    // Poison at the start trips the fan-out, so the held set is everything
    // after it -- good files in the middle, poison again at the tail. The drain
    // walks from the far end first, so its opening pass runs straight into the
    // trailing cluster, spends its whole budget and places NOTHING. A rule that
    // reads that as "the backend is dead" hands back every good patch between
    // the two clusters, unsent; and because the mtime baseline is never written
    // on a run with commit errors, the next map reproduces it exactly.
    fixture(30);
    backend.poison = [
      "m000.ts", "m001.ts", "m002.ts", "m003.ts", "m004.ts", "m005.ts",
      "m024.ts", "m025.ts", "m026.ts", "m027.ts", "m028.ts", "m029.ts",
    ];
    // The premise, checked rather than assumed: poison first and last.
    const order = discoveryOrder();
    expect(order[0]).toContain("m000.ts");
    expect(order[order.length - 1]).toContain("m029.ts");

    const summary = await run();

    expect(summary.commitErrors, "exactly the poison, nothing else").toBe(12);
    expect(summary.patchesApplied, "every file between the clusters").toBe(18);
  });

  it("bounds a bulk 409 that names every patch as already landed", async () => {
    // Those patches are confirmed in the graph by the server's own body, so
    // re-sending them is bookkeeping -- but nothing bounded it: the full-landed
    // branch returns before its shouldStop check, so the whole chunk went out
    // one at a time behind the global mutex with no way to stop.
    fixture(30);
    backend.bulk409AllLanded = true;

    const summary = await run();

    expect(summary.patchesApplied, "confirmed landed, so not errors").toBe(30);
    expect(summary.commitErrors).toBe(0);

    // PINNED, not endorsed. On a HEALTHY backend the replay re-sends all 30 one
    // at a time even though the 409 body already named them as landed -- the
    // Ix#495 shape, and provably unnecessary work. Skipping them outright needs
    // a revision for `onCommitted` that the 409 does not carry, so it is left
    // as a known residue rather than guessed at. This number failing is the
    // signal that someone changed it deliberately.
    expect(backend.singleCount, "known residue: one re-send per confirmed patch").toBe(30);
  });

  it("bounds the replay, and counts it applied, when the re-sends fail too", async () => {
    // The case that could actually run away, and the one the previous test
    // cannot distinguish: there the healthy backend accepts every re-send, so
    // `patchesApplied` reaches 30 whether or not the 409's ids are credited.
    // Here every re-send is refused.
    //
    // Two things have to hold. The patches are still APPLIED -- the server's
    // own 409 said it holds them, so counting a failed re-send as a commit
    // error would report writes the graph has as missing and suppress the mtime
    // baseline over them. And the replay has to STOP: the full-landed branch
    // returns before its `shouldStop` check, so nothing else bounds it, and it
    // would otherwise send all 30 one at a time behind the global mutex.
    fixture(30);
    backend.bulk409AllLanded = true;
    backend.refuseReplays = true;

    const summary = await run();

    expect(summary.commitErrors, "confirmed landed, so not errors").toBe(0);
    expect(summary.patchesApplied).toBe(30);
    expect(backend.singleCount, "bounded by the failure limit, not one per patch").toBeLessThan(15);
  });

  it("refuses a second stitch to a backend still running the last one (Ix#568)", async () => {
    // The marker is written when a stitch STARTS and removed only on proof
    // nothing is running. A 500 is not proof -- ArangoDB keeps executing the
    // join -- so the next run must not start another.
    fixture(4);
    backend.stitchStatus = 500;

    const first = await run();
    expect(backend.stitchCount, "the first run does stitch").toBe(1);
    expect(first.stitchSkipped).toBeUndefined();

    const second = await run();

    expect(backend.stitchCount, "and the second does not").toBe(1);
    expect(second.stitchSkippedRule).toBe("cooling");
    expect(second.stitchSkipped).toContain("may still be running");
  });

  it("stitches again once the cooldown is disabled", async () => {
    // The refusal message tells the user IX_STITCH_COOLDOWN_MS=0 releases it,
    // so that has to be true of a cooldown already on disk.
    fixture(4);
    backend.stitchStatus = 500;
    await run();
    expect(backend.stitchCount).toBe(1);

    process.env.IX_STITCH_COOLDOWN_MS = "0";
    try {
      const second = await run();
      expect(backend.stitchCount).toBe(2);
      expect(second.stitchSkipped).toBeUndefined();
    } finally {
      delete process.env.IX_STITCH_COOLDOWN_MS;
    }
  });

  it("blames the clock for the clock's losses, not the backend", async () => {
    // The cutoff and the run deadline both abandon patches, and three separate
    // review rounds found them attributed to each other -- the run telling the
    // user to raise IX_MAP_DEADLINE_MS for patches the cutoff had deliberately
    // withheld, or the reverse. They are tracked in separate lists precisely so
    // this message can be right.
    //
    // The deadline is fired by the BACKEND, after a known number of commit
    // requests, rather than by a wall-clock timeout. A timeout here measured
    // discovery and parsing, not the commit phase -- on this machine the first
    // commit did not land for ~700ms, so a 420ms budget never reached the code
    // under test at all, and on a faster machine the same test would have
    // asserted the opposite branch.
    fixture(30);
    backend.refuseEverything = true;
    backend.abortAfterCommits = 3;

    const message = await (async () => {
      try {
        await ingestFiles(repo, {
          format: "text",
          force: true,
          suppressOutput: true,
          printSummary: false,
          deadlineSignal: backend.deadlineSignal,
        });
        return "";
      } catch (err) {
        return String(err);
      }
    })();

    // Exactly three requests reached the backend, so the abort landed where it
    // was aimed and the rest were stopped before they left.
    expect(backend.commitCount).toBe(3);
    // The clock's losses are reported as the clock's, and every patch is
    // accounted for. An earlier revision reported them as the cutoff's --
    // "sending them one at a time would have added load to a backend that is
    // already the reason they fail" -- for patches the cutoff never touched.
    expect(message).toContain("ran out of time");
    expect(message).toContain("30 file patches");
    expect(message).not.toContain("added load");
  });

  it("commits a healthy repo in one bulk, with no per-file fan-out", async () => {
    fixture(12);

    const summary = await run();

    expect(summary.commitErrors).toBe(0);
    expect(summary.patchesApplied).toBe(12);
    expect(backend.bulkCount).toBe(1);
    expect(backend.singleCount, "the fan-out is for failures only").toBe(0);
  });
});
