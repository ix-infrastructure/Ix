// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { ingestMtimeCachePath, ingestRebuildPath, loadConfig } from "../config.js";
import { workspaceIdForPath } from "../system.js";
import { FakeBackend } from "./helpers/fake-backend.js";

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

describe("ingestFiles against a fake backend", () => {
  // Every test here runs a REAL ingest -- discovery, a worker-thread parse
  // pool, and an HTTP round trip per commit -- against 30 files. On an idle
  // machine each takes about a second, comfortably inside vitest's 5s default,
  // which is why this file went in without an explicit timeout. Under the full
  // suite's parallelism that is not true: measured on `main`, the Ix#560 case
  // exceeded 5s and failed in 1 of 4 full `ix-cli` runs here, and in 3 of 3
  // when the heavier repo-root suite was running. A timeout that fires only
  // under load reads as a real regression on whichever CI leg was busiest, so
  // it is set from the work these tests actually do rather than inherited.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  let home: string;
  let repo: string;
  let backend: FakeBackend;
  // The sentinel for `backend`, in the same spirit as the `""` reset that
  // `home` and `repo` get. `backend` cannot use `undefined` as its own: it is
  // read as a plain `FakeBackend` at ~35 call sites in the tests below, and
  // widening the type to make teardown honest would put a narrowing burden on
  // every one of them. So the freshness lives beside it instead. False means
  // "`backend` does not refer to THIS test's fake" -- either the first test
  // has not constructed one yet, or a `beforeEach` threw before it got there.
  let backendIsCurrent = false;
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
      writeFileSync(
        join(repo, "src", name),
        `export function f${i}(): number { return ${i}; }\n`,
        "utf8",
      );
    }
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  }

  /** The order discovery will actually walk — asserted, never assumed. */
  // The same flags `tryGitLsFiles` passes, not a bare `ls-files`. The two
  // agree only while `fixture()` stages everything; one unstaged file or a
  // `.gitignore` and this would validate a list discovery does not use. The
  // both-ends fixture is the only one that reproduces the drain's
  // first-empty-pass bug, so a premise check that quietly stopped matching
  // would retire that case with nothing going red.
  function discoveryOrder(): string[] {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  }

  beforeEach(async () => {
    // realpath'd, because discovery canonicalises and the workspace root does
    // not. `discoverIngestFilePaths` runs `realpathSync.native` over every file
    // it finds while `workspaceRoot` stays exactly the string handed in, so the
    // moment the two disagree `toWorkspaceRelative` gives up and emits an
    // ESCAPING path. On the two macos-14 legs `os.tmpdir()` is `/var/folders/...`
    // for a real `/private/var/folders/...`, so every fixture's source_uri and
    // patch id there was `../../../private/var/...` rather than `src/m000.ts` --
    // a materially different payload on a third of the matrix, and a trap for
    // the first assertion that ever touches a uri. Windows junctions do it too.
    // `ingest-discovery.test.ts:105` already carries this fix and its reason.
    // THIS is what makes the teardown correct. The guards down there are the
    // decorative half, and an earlier version of this comment had it backwards.
    //
    // All three are describe-scoped and `afterEach` never reset them, so from
    // the second test onward they held the PREVIOUS test's values. A
    // `beforeEach` that throws anywhere in the setup then left the teardown
    // asserting against the previous test's already-stopped fake and calling
    // `rmSync` on its already-deleted paths -- a silent no-op under
    // `force: true`, so nothing went red. Clearing here is the only reason
    // each test's teardown sees its own state.
    //
    // (A throw in `mkdtempSync` itself leaks nothing, since no directory got
    // made. The leak that WAS reachable came from `realpathSync` throwing
    // after one existed, and the split assignment below is what closes it.)
    //
    // `""` rather than `undefined`, because typing these as `string |
    // undefined` costs a non-null assertion at forty use sites for no extra
    // safety -- and `rmSync("")` is a no-op on Node 26, checked, where
    // `rmSync(undefined)` throws ERR_INVALID_ARG_TYPE.
    //
    // Cleared FIRST, then set immediately after the construction it describes,
    // so the window in which `backendIsCurrent` is false is exactly the window
    // in which `backend` is stale. A statement inserted above the assignment
    // that throws now leaves the flag false and the teardown skips rather than
    // asserting against the previous test's fake and passing vacuously.
    // Constructing first is still the better position -- keep it first -- but
    // it is no longer the only thing standing between that edit and a silent
    // pass.
    backendIsCurrent = false;
    home = "";
    repo = "";
    backend = new FakeBackend();
    backendIsCurrent = true;
    // Two steps each, deliberately. `realpathSync(mkdtempSync(...))` leaves
    // nothing in `home` if the OUTER call throws -- and the directory exists
    // by then, so the `if (home)` cleanup below skips a tree that is already
    // on disk. Assigning the created path first means the variable always
    // names whatever was created, resolved or not.
    home = mkdtempSync(join(tmpdir(), "ix-ingest-home-"));
    // `.native`, as discovery canonicalises: on Windows the temp dir is an 8.3
    // name (RUNNER~1) that plain realpathSync keeps and `.native` expands, so
    // paths built from `repo` would not match the ones ingest records.
    home = realpathSync.native(home);
    repo = mkdtempSync(join(tmpdir(), "ix-ingest-repo-"));
    repo = realpathSync.native(repo);
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

  /**
   * Remove a temp tree without letting one failure strand the next. `rmSync`
   * with `force` suppresses ENOENT only; EBUSY and EPERM still throw, and on
   * Windows they are ordinary -- a handle under `IX_LOCK_DIR` is enough. The
   * leak is reported rather than raised, because failing the teardown here
   * would mask whatever the test itself was failing on.
   */
  const removeTree = (dir: string): void => {
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`ingest-files teardown: could not remove ${dir}: ${String(err)}\n`);
    }
  };

  afterEach(async () => {
    try {
      // Every request the run made was one this fake actually implements. If
      // the ingest path grows an endpoint, this fails once with its name,
      // rather than ten tests passing against a fake that agreed with
      // everything.
      // Guarded on freshness, not on existence. `backend` is typed
      // non-nullable and holds the PREVIOUS test's fake after the first one,
      // so an `!== undefined` test here would be true in precisely the case
      // worth catching -- a `beforeEach` that threw above the assignment --
      // and would assert against the wrong object and pass.
      //
      // Be clear about what this flag is and is not. It is DORMANT: nothing
      // between the reset and the assignment can throw today, so replacing it
      // with `true` leaves the suite green, and no test covers it. What it
      // buys over the `!== undefined` it replaced is not coverage but
      // correctness WHEN it fires -- the old guard was dormant AND could not
      // have worked, since the stale fake is never `undefined`. Verified by
      // running both forms against a `beforeEach` that throws above the
      // assignment: the old one asserted twice against the first test's fake,
      // the new one skipped.
      if (backendIsCurrent) {
        expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
      }
    } finally {
      // In a `finally`, because the assertion above threw straight past all of
      // this -- in exactly the case it exists for. The server stayed listening
      // (an open handle that can stop the vitest worker exiting, turning one
      // named failure into a job timeout), both temp trees leaked, and
      // `HOME`/`USERPROFILE`/`IX_ENDPOINT` stayed pointed at the fixture. Worse,
      // `saved` is shared across the describe, so the next `beforeEach`
      // snapshotted those polluted values and the file's final restore wrote
      // the fixture `HOME` back into the process.
      // And the steps do not share fate. Env first, because it is the one that
      // leaks OUT of this file: a `stop()` that REJECTS would otherwise skip it
      // and leave the whole process pointed at a deleted fixture home. Note
      // what this does NOT buy -- on a hook timeout the hook promise is rejected
      // from outside while the `await` is still pending, so no `finally` here
      // runs at all. That case is handled where it has to be, by making
      // `stop()` unable to hang. The stop is guarded on the same freshness
      // flag: a `beforeEach` that threw above the construction leaves
      // `backend` pointing at the previous test's fake, which its own
      // teardown already stopped. A throw in the `mkdtempSync` calls is a
      // different case and needs no guard of its own -- `start()` runs below
      // them, so the fake was constructed but never listened, and `stop()`
      // returns at its own `if (!this.server)`.
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        if (backendIsCurrent) await backend.stop();
      } finally {
        // FIRST, and before anything that can throw. The flag means
        // "constructed by the `beforeEach` for the test now running" rather
        // than "constructed at some point": without clearing it, it stays
        // `true` forever after the first test, and a file- or project-level
        // `beforeEach` added later that throws BEFORE this describe's own
        // would find it set and assert against the stale fake -- the bug,
        // through the one door the flag does not otherwise cover.
        //
        // It sat below the two removals and shared their fate, which was the
        // same mistake the outer `finally` above exists to avoid: `rmSync`
        // suppresses only ENOENT, so one EBUSY on Windows -- a lock file under
        // `IX_LOCK_DIR`, a `.git` handle -- skipped it AND the second removal.
        backendIsCurrent = false;
        // Separately, for the same reason. `removeTree` swallows per
        // directory so `home` failing cannot strand `repo`, and so a teardown
        // error cannot replace an in-flight `unknownPaths` failure and hide
        // which endpoint was unimplemented.
        //
        // The `if` inside guards exactly one case: `mkdtempSync` itself threw,
        // so nothing was created and the variable still holds the `""` from
        // the reset above. Every other failure leaves it naming a real
        // directory, which is why the assignment is split from the
        // `realpathSync` that follows it. Not a stale path from a previous
        // test -- the reset covers that, and `rmSync("")` is a no-op anyway.
        removeTree(home);
        removeTree(repo);
      }
    }
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
      "m000.ts",
      "m001.ts",
      "m002.ts",
      "m003.ts",
      "m004.ts",
      "m005.ts",
      "m024.ts",
      "m025.ts",
      "m026.ts",
      "m027.ts",
      "m028.ts",
      "m029.ts",
    ];
    // The premise, checked rather than assumed: poison first and last.
    const order = discoveryOrder();
    expect(order[0]).toContain("m000.ts");
    expect(order[order.length - 1]).toContain("m029.ts");

    const summary = await run();

    expect(summary.commitErrors, "exactly the poison, nothing else").toBe(12);
    expect(summary.patchesApplied, "every file between the clusters").toBe(18);
  });

  it("pins the unbounded replay of a 409 that names every patch as landed", async () => {
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

  it("counts a lost base-rev race as an error on the CUTOFF DRAIN too", async () => {
    // A backend can answer 200 and still have written nothing: `BaseRevMismatch`
    // means it read the latest rev outside the transaction and the rev moved
    // before the commit ran. `onBulkCommitted` and the per-file path both guard
    // that; the cutoff drain added for Ix#571 did not, and counted the whole
    // chunk as applied.
    //
    // Why that is worse than a wrong number: `commitErrors` staying at zero is
    // exactly the condition `persistIngestBaselineIfClean` requires, so the run
    // writes an mtime baseline for files the graph never received and every
    // later incremental map skips them as unchanged. Silent, and recoverable
    // only with `--force`.
    //
    // Reaching an ACCEPTED drain took three tries, each of which measured the
    // wrong thing until `acceptedBulks()` was added to check the premise --
    // see `refuseUntilDrain`. The sequence this produces is:
    //
    //   BULK:30 => 500     the opening bulk, refused
    //   one:1   => 500     x5, refused, which trips the cutoff
    //   BULK:25 => 200     the drain, ACCEPTED -- the request under test
    fixture(30);
    backend.refuseUntilDrain = true;

    const clean = await run();
    // The premise, checked rather than assumed: a drain bulk was accepted, and
    // it is what placed the patches.
    expect(backend.acceptedBulks(), "the drain bulk must be ACCEPTED").toBe(1);
    expect(clean.patchesApplied, "the drain placed the held patches").toBe(25);

    // Same fixture, same refusals, same `--force` re-ingest. The ONLY thing
    // that changes is the status the accepted drain answers with.
    backend.resetRequests();
    backend.mismatchOnDrainBulk = true;
    const message = await runFatal();

    // Nothing landed, so the run must say so and end fatally. Without the
    // guard the 25 patches the backend declined to write are counted as
    // applied, the run reports the same 5 errors as the clean case, exits 0 --
    // and `runFatal` fails with "expected the ingest to end fatally", which is
    // this test's real assertion.
    expect(message).toContain("30 of 30");
  });

  it("re-ingests everything once when the baseline names another extractor", async () => {
    // `ix map` skips files by mtime and source hash, and neither sees an
    // extractor bump, so the baseline records the extractor and a change
    // forces one full re-ingest. Asserted through the notice and the stored
    // name: this fake answers no source hashes, so its DB-reset guard makes
    // every incremental run look forced anyway.
    fixture(3);
    const incremental = () =>
      ingestFiles(repo, { format: "text", suppressOutput: true, printSummary: false });
    const stored = () =>
      JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8")) as { extractor?: string };
    const notices = (): string[] =>
      stderr.mock.calls.map(([chunk]) => String(chunk)).filter(c => c.includes("[extractor changed]"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await incremental();
      const current = stored().extractor;
      expect(current, "a clean run records its extractor").toMatch(/^tree-sitter\//);
      expect(notices(), "a first run has no baseline to compare").toEqual([]);

      writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...stored(), extractor: "tree-sitter/0.1" }));
      await incremental();
      expect(notices()).toEqual([expect.stringContaining(`tree-sitter/0.1 -> ${current}`)]);
      expect(stored().extractor).toBe(current);

      await incremental();
      expect(notices(), "the new name was recorded, so it happens once").toHaveLength(1);

      const { extractor: _dropped, ...unrecorded } = stored();
      writeFileSync(ingestMtimeCachePath(repo), JSON.stringify(unrecorded));
      await incremental();
      expect(notices()[1], "a baseline from before this was recorded").toContain(`unrecorded -> ${current}`);

      writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...stored(), extractor: "tree-sitter/0.1" }));
      await ingestFiles(repo, { format: "text", lang: "typescript", suppressOutput: true, printSummary: false });
      expect(stored().extractor, "a --lang run must not vouch for the other languages").toBe("tree-sitter/0.1");

      writeFileSync(join(repo, "root.ts"), "export const r = 1;\n", "utf8");
      execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
      await incremental();
      writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...stored(), extractor: "tree-sitter/0.1" }));
      await ingestFiles(join(repo, "root.ts"), { format: "text", suppressOutput: true, printSummary: false });
      expect(stored().extractor, "a single-file run must not vouch for the rest").toBe("tree-sitter/0.1");
    } finally {
      stderr.mockRestore();
    }
  });

  it("resumes an extractor re-ingest that was cut short instead of starting over", async () => {
    // The re-ingest an extractor change forces takes about twice a first map,
    // and an editor hook with a timeout can cut it short. The baseline is only
    // written by a run that finishes, so without recorded progress every later
    // run started over -- and could be cut short at the same point, forever.
    fixture(30);
    backend.rememberHashes = true;
    const incremental = () =>
      ingestFiles(repo, { format: "text", suppressOutput: true, printSummary: false });
    const stored = () =>
      JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8")) as { extractor?: string };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await incremental();
      const current = stored().extractor;
      writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...stored(), extractor: "tree-sitter/0.1" }));

      // Cut short: three files' patches never land, so the run cannot finish.
      backend.resetRequests();
      backend.poison = ["m007.ts", "m015.ts", "m023.ts"];
      await incremental().catch(() => undefined);
      expect(stored().extractor, "an unfinished re-ingest must not vouch for the new extractor").toBe("tree-sitter/0.1");
      expect(existsSync(ingestRebuildPath(repo)), "what landed is recorded").toBe(true);

      backend.resetRequests();
      backend.poison = [];
      await incremental();
      const notices = stderr.mock.calls.map(([chunk]) => String(chunk)).filter(c => c.includes("[extractor changed]"));
      expect(notices.at(-1)).toContain("Resuming the re-ingest: 27 of 30 files already done.");
      expect(backend.acceptedPatches(), "only the three that never landed are sent again").toBe(3);
      expect(stored().extractor).toBe(current);
      expect(existsSync(ingestRebuildPath(repo)), "a finished re-ingest leaves no progress behind").toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("keeps a deletion it could not clean up in the baseline, so the next run retries it", async () => {
    // A failed hash lookup with deletions pending drops them for this run. The
    // baseline it then wrote came from the files still on disk, so it no
    // longer named the deleted file: no later run could find it deleted, and
    // its nodes stayed in the graph for good.
    fixture(3);
    backend.rememberHashes = true;
    const incremental = () =>
      ingestFiles(repo, { format: "text", suppressOutput: true, printSummary: false });
    const baselineFiles = () =>
      Object.keys((JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8")) as { files: Record<string, number> }).files);
    const deleted = join(repo, "src", "m001.ts");

    await incremental();
    expect(baselineFiles()).toContain(deleted);

    rmSync(deleted);
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    backend.failSourceHashes = true;
    await incremental();

    expect(baselineFiles(), "the skipped deletion is still pending").toContain(deleted);
    expect(baselineFiles()).toEqual(expect.arrayContaining([join(repo, "src", "m000.ts"), join(repo, "src", "m002.ts")]));
  });

  it("ingests only the languages --lang names, and keeps the rest of the baseline", async () => {
    fixture(3);
    writeFileSync(join(repo, "src", "tool.py"), "def tool():\n    return 1\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    const baselineFiles = () =>
      Object.keys((JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8")) as { files: Record<string, number> }).files);

    await ingestFiles(repo, { format: "text", suppressOutput: true, printSummary: false });
    const everything = baselineFiles();
    expect(everything).toHaveLength(4);

    backend.resetRequests();
    const summary = await ingestFiles(repo, { format: "text", force: true, lang: "py", suppressOutput: true, printSummary: false });
    expect(summary.filesDiscovered, "only the Python file is in scope").toBe(1);
    expect(backend.acceptedPatches()).toBe(1);
    expect(baselineFiles().sort(), "the TypeScript files keep their entries").toEqual([...everything].sort());
  });

  it("names a missing path rather than failing with a bare ENOENT", async () => {
    await expect(
      ingestFiles(join(repo, "no-such-dir"), { format: "text", suppressOutput: true, printSummary: false }),
    ).rejects.toThrow(/^Path not found: /);
  });

  it("sends workspace-relative uris when the path it is given is a symlink", async () => {
    // Discovery canonicalises every file with realpath; the root has to be
    // canonical too, or every source_uri comes out as `../<real dir>/src/x.ts`
    // (macOS /tmp -> /private/tmp, Windows 8.3 names, any symlinked checkout).
    fixture(2);
    const link = `${repo}-link`;
    symlinkSync(repo, link, "dir");
    try {
      await ingestFiles(link, { format: "text", force: true, suppressOutput: true, printSummary: false });
    } finally {
      rmSync(link, { force: true });
    }
    expect(backend.sourceUris.length).toBeGreaterThan(0);
    expect([...new Set(backend.sourceUris)].sort()).toEqual(["src/m000.ts", "src/m001.ts"]);
  });

  it("re-sends commits that lost the base-rev race to another writer", async () => {
    // Two `ix map` runs against one backend: each commit that lands moves the
    // rev under the other's in-flight commit, which is answered 200
    // BaseRevMismatch and writes nothing. Those used to be counted as failed
    // and left for the next run -- a third of the repo missing and exit 1.
    fixture(30);
    backend.loseBaseRevRaces = 3;

    const summary = await run();

    expect(summary.commitErrors, "every lost race was re-sent and landed").toBe(0);
    expect(summary.patchesApplied).toBe(30);
    expect(backend.bulkCount, "the same bulk, sent until it won").toBe(4);
    expect(backend.singleCount, "a lost race is not a reason to fan out").toBe(0);
  });

  it("still reports a race it keeps losing, after the retries", async () => {
    fixture(12);
    process.env.IX_COMMIT_BASE_REV_RETRIES = "2";
    backend.loseBaseRevRaces = 1_000;
    try {
      const message = await runFatal().catch((err: unknown) => String(err));
      expect(message).toMatch(/12 of 12|failed to commit/);
    } finally {
      delete process.env.IX_COMMIT_BASE_REV_RETRIES;
    }
  });

  it("commits a healthy repo in one bulk, with no per-file fan-out", async () => {
    fixture(12);

    const summary = await run();

    expect(summary.commitErrors).toBe(0);
    expect(summary.patchesApplied).toBe(12);
    expect(backend.bulkCount).toBe(1);
    expect(backend.singleCount, "the fan-out is for failures only").toBe(0);
  });

  // ── Which workspace a path belongs to ─────────────────────────────────
  //
  // `ix ingest <path>` used to treat the path as its own workspace root: `ix
  // ingest src/a.ts` in a mapped repo registered `repo/src` as a second
  // workspace, sent `a.ts` instead of `src/a.ts` under that workspace's id,
  // and from then on every read under `src/` resolved to the hollow one.

  /** Register `roots` in the config by hand, so no ingest has run yet. */
  const register = (...roots: Array<{ root: string; isDefault?: boolean }>): void => {
    mkdirSync(join(home, ".ix"), { recursive: true });
    writeFileSync(join(home, ".ix", "config.yaml"), [
      "endpoint: http://localhost:8090",
      "format: text",
      "workspaces:",
      ...roots.flatMap(({ root, isDefault }) => [
        `  - workspace_id: "${workspaceIdForPath(root)}"`,
        `    workspace_name: ${root.split(/[\\/]/).pop()}`,
        `    root_path: ${root}`,
        `    default: ${isDefault === true}`,
      ]),
      "",
    ].join("\n"));
  };
  const registered = () =>
    (loadConfig().workspaces ?? []).map(w => ({ root: w.root_path, id: w.workspace_id, isDefault: w.default }));
  const sent = () => backend.sourceUris.map((uri, i) => ({ uri, workspaceId: backend.sourceWorkspaceIds[i] }));
  const quiet = { format: "text", suppressOutput: true, printSummary: false } as const;

  it("ingests a file or subdirectory inside a registered workspace into THAT workspace", async () => {
    fixture(2);
    mkdirSync(join(repo, "src", "util"), { recursive: true });
    writeFileSync(join(repo, "src", "util", "u.ts"), "export const u = 1;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    // Registered, but deliberately NOT the default: a stray registration
    // became the default whenever none was set.
    register({ root: repo, isDefault: false });
    const before = registered();
    const repoId = workspaceIdForPath(repo);

    await ingestFiles(join(repo, "src", "m001.ts"), { ...quiet, force: true });
    expect(sent()).toEqual([{ uri: "src/m001.ts", workspaceId: repoId }]);

    backend.sourceUris.length = 0;
    backend.sourceWorkspaceIds.length = 0;
    await ingestFiles(join(repo, "src", "util"), { ...quiet, force: true });
    expect(sent()).toEqual([{ uri: "src/util/u.ts", workspaceId: repoId }]);

    expect(registered(), "no workspace registered, and the default left alone").toEqual(before);
  });

  it("uses the git root for a path in a repository nobody has registered", async () => {
    fixture(2);
    await ingestFiles(join(repo, "src"), { ...quiet, force: true });

    expect(registered()).toEqual([{ root: repo, id: workspaceIdForPath(repo), isDefault: true }]);
    expect([...new Set(sent().map(s => `${s.workspaceId} ${s.uri}`))].sort()).toEqual([
      `${workspaceIdForPath(repo)} src/m000.ts`,
      `${workspaceIdForPath(repo)} src/m001.ts`,
    ]);
  });

  it("still gives a path in no workspace and no repository a workspace of its own", async () => {
    // `repo` here is a plain directory: no `fixture()`, so no `git init`.
    const outside = join(repo, "loose");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "x.ts"), "export const x = 1;\n", "utf8");

    await ingestFiles(join(outside, "x.ts"), { ...quiet, force: true });

    expect(registered()).toEqual([{ root: outside, id: workspaceIdForPath(outside), isDefault: true }]);
    expect(sent()).toEqual([{ uri: "x.ts", workspaceId: workspaceIdForPath(outside) }]);
  });

  it("leaves everything outside a subdirectory run alone: deletions, baseline, extractor, stitch", async () => {
    fixture(2);
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "l0.ts"), "export const l0 = 0;\n", "utf8");
    writeFileSync(join(repo, "lib", "l1.ts"), "export const l1 = 1;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    backend.rememberHashes = true;
    type Stored = { files: Record<string, number>; extractor?: string; lastIngestAt: string };
    const stored = () => JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8")) as Stored;

    await ingestFiles(repo, quiet);
    // An older extractor on record: a full run would re-ingest everything and
    // record the new name; a run over `src/` has vouched for none of `lib/`.
    writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...stored(), extractor: "tree-sitter/0.1" }));
    const baselineBefore = stored();
    const deleted = join(repo, "lib", "l0.ts");
    expect(Object.keys(baselineBefore.files)).toContain(deleted);

    // Gone from disk, so a run over the whole root would delete it. A run over
    // `src/` must not: it says nothing about `lib/`. (Were it attempted, the
    // reconcile's `GET /v1/patches/...` would land in `unknownPaths`.)
    rmSync(deleted);
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    backend.resetRequests();
    backend.sourceUris.length = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // --force, so nothing is skipped as unchanged: on the whole root that
      // is exactly the run that re-registers the stitch.
      await ingestFiles(join(repo, "src"), { ...quiet, force: true });
    } finally {
      stderr.mockRestore();
    }

    expect([...new Set(backend.sourceUris)].sort()).toEqual(["src/m000.ts", "src/m001.ts"]);
    expect(backend.stitchCount, "a slice of the repo is not its registration").toBe(0);
    const after = stored();
    expect(after.files[deleted], "the deletion is the next full map's").toBe(baselineBefore.files[deleted]);
    expect(after.files[join(repo, "lib", "l1.ts")]).toBe(baselineBefore.files[join(repo, "lib", "l1.ts")]);
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(baselineBefore.files).sort());
    expect(after.extractor, "the rest of the workspace keeps its extractor").toBe("tree-sitter/0.1");
    expect(after.lastIngestAt, "the last full ingest is still the last full ingest").toBe(baselineBefore.lastIngestAt);
    expect(existsSync(ingestRebuildPath(repo)), "no whole-workspace rebuild is started").toBe(false);
  });

  it("resolves a scoped run's edges against the whole workspace, not just the scope", async () => {
    // `src/a.ts` imports `lib/b.ts`. A run over `src/` re-sends a.ts's patch,
    // and resolving it against `src/` alone dropped the import edge from it.
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "b.ts"), "export function b(): number { return 1; }\n", "utf8");
    writeFileSync(join(repo, "src", "a.ts"), "import { b } from '../lib/b';\nexport function a(): number { return b(); }\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    const edges = () => (backend.lastOps.get("src/a.ts") ?? [])
      .filter(op => op.type === "UpsertEdge")
      .map(op => `${String(op.predicate)} ${String(op.dst)}`)
      .sort();

    await ingestFiles(repo, { ...quiet, force: true });
    const full = edges();
    expect(full.some(e => e.startsWith("IMPORTS ")), "the fixture has an import edge to lose").toBe(true);

    backend.lastOps.clear();
    await ingestFiles(join(repo, "src"), { ...quiet, force: true });
    expect(edges()).toEqual(full);
  });

  it("writes no baseline from a subdirectory run when the workspace has none", async () => {
    // One written from `src/` alone would report the whole graph complete.
    fixture(2);
    mkdirSync(join(repo, "lib"), { recursive: true });
    writeFileSync(join(repo, "lib", "l0.ts"), "export const l0 = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    register({ root: repo, isDefault: true });

    await ingestFiles(join(repo, "src"), { ...quiet, force: true });

    expect(existsSync(ingestMtimeCachePath(repo))).toBe(false);
    expect(existsSync(ingestMtimeCachePath(join(repo, "src")))).toBe(false);
  });

  it("keeps a member repo's own workspace id, inside a registered system or on its own", async () => {
    // `repo` is the plain folder holding two independently cloned repos.
    for (const member of ["alpha", "beta"]) {
      mkdirSync(join(repo, member), { recursive: true });
      writeFileSync(join(repo, member, `${member}.ts`), `export const ${member} = 1;\n`, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: join(repo, member), stdio: "ignore" });
      execFileSync("git", ["add", "-A"], { cwd: join(repo, member), stdio: "ignore" });
    }
    const alpha = join(repo, "alpha");
    const alphaId = workspaceIdForPath(alpha);

    // Standalone: nothing registered, so the member's git root -- exactly
    // what `ix map` inside it produces.
    await ingestFiles(join(alpha, "alpha.ts"), { ...quiet, force: true });
    expect(sent()).toEqual([{ uri: "alpha.ts", workspaceId: alphaId }]);
    expect(registered().map(w => w.root)).toEqual([alpha]);

    // Inside the registered system: the system's workspace, with the uri the
    // co-ingest gave the file and, still, the member's own id.
    register({ root: repo, isDefault: true });
    backend.sourceUris.length = 0;
    backend.sourceWorkspaceIds.length = 0;
    await ingestFiles(join(alpha, "alpha.ts"), { ...quiet, force: true });
    expect(sent()).toEqual([{ uri: "alpha/alpha.ts", workspaceId: alphaId }]);
    expect(registered().map(w => w.root)).toEqual([repo]);
  });
});
