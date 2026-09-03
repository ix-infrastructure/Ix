import { describe, expect, it } from "vitest";

import { describeCommitOutcome, describeStitchFailure, describeStitchSkipped, ingestCompletedCleanly, isStitchUnsupported } from "../commands/ingest.js";

describe("describeCommitOutcome", () => {
  it("says nothing when every patch committed", () => {
    expect(describeCommitOutcome(0, 120)).toEqual({ kind: "ok" });
    expect(describeCommitOutcome(0, 0)).toEqual({ kind: "ok" });
  });

  it("is fatal when nothing landed at all", () => {
    // The case this exists for. `ix map` passes suppressOutput, so a run where
    // the backend accepted no patches used to return normally and let map.ts
    // print regions built from a stale graph. map.ts turns a throw into
    // emitError + exit 1, so being fatal here is what makes the failure visible.
    const outcome = describeCommitOutcome(42, 0);
    expect(outcome.kind).toBe("fatal");
    expect(outcome.kind === "fatal" && outcome.message).toContain("committed nothing");
    expect(outcome.kind === "fatal" && outcome.message).toContain("42");
  });

  it("warns but does not throw when the run was partly successful", () => {
    // Some patches landed, so the graph moved forward and failing the whole
    // command would be an overreaction. The mtime cache is not written on a run
    // with commit errors, so the next run retries the files that failed.
    const outcome = describeCommitOutcome(3, 97);
    expect(outcome.kind).toBe("warn");
    expect(outcome.kind === "warn" && outcome.message).toContain("3 of 100");
  });

  it("counts the total as failures plus successes, not files discovered", () => {
    // Skipped-unchanged files are not part of this ratio; quoting a denominator
    // that includes them would understate how much of the attempted work failed.
    const outcome = describeCommitOutcome(1, 1);
    expect(outcome.kind === "warn" && outcome.message).toContain("1 of 2");
  });

  it("keeps the fatal message grammatical for a single patch", () => {
    const one = describeCommitOutcome(1, 0);
    expect(one.kind === "fatal" && one.message).toContain("all 1 patch failed");
    const many = describeCommitOutcome(2, 0);
    expect(many.kind === "fatal" && many.message).toContain("all 2 patches failed");
  });

  it("treats a negative count as nothing to report", () => {
    // Defensive: the caller increments a counter, but nothing here should turn
    // an impossible value into a thrown error that fails an otherwise fine run.
    //
    // patchesApplied must be 0 here. With a positive value the fatal branch is
    // unreachable under any implementation of the first guard, so the case
    // asserted nothing about the invariant it names.
    expect(describeCommitOutcome(-1, 0)).toEqual({ kind: "ok" });
    expect(describeCommitOutcome(-1, 10)).toEqual({ kind: "ok" });
  });

  it("names a flag the running command actually has", () => {
    // `ix map` has no --debug and never passed one to ingestFiles, so the
    // remediation the message offered was inert on the only path where the
    // failure is otherwise invisible. map passes --verbose instead.
    const mapFatal = describeCommitOutcome(5, 0, "--verbose");
    expect(mapFatal.kind === "fatal" && mapFatal.message).toContain("--verbose");
    expect(mapFatal.kind === "fatal" && mapFatal.message).not.toContain("--debug");

    const mapWarn = describeCommitOutcome(5, 5, "--verbose");
    expect(mapWarn.kind === "warn" && mapWarn.message).toContain("--verbose");

    // ix ingest keeps --debug, which it does have.
    const ingestFatal = describeCommitOutcome(5, 0);
    expect(ingestFatal.kind === "fatal" && ingestFatal.message).toContain("--debug");
  });

  it("blames the deadline, not the backend, when the run was cut short", () => {
    // A fired map deadline aborts every in-flight request, and each abort lands
    // in commitErrors. Reporting that as "the backend rejected your patches"
    // points the user at the wrong system; the fix is a longer budget.
    const fatal = describeCommitOutcome(40, 0, "--verbose", true);
    expect(fatal.kind).toBe("fatal");
    expect(fatal.kind === "fatal" && fatal.message).toContain("ran out of time");
    expect(fatal.kind === "fatal" && fatal.message).toContain("IX_MAP_DEADLINE_MS");
    expect(fatal.kind === "fatal" && fatal.message).not.toContain("failed to commit.");

    // Still only fatal when nothing landed — a partial run under the deadline
    // moved the graph forward and is a warning, same as any other partial.
    const partial = describeCommitOutcome(40, 10, "--verbose", true);
    expect(partial.kind).toBe("warn");
    expect(partial.kind === "warn" && partial.message).toContain("ran out of time");
  });
});

describe("ingestCompletedCleanly", () => {
  it("is false when patches failed to commit", () => {
    // The guard the PR calls load-bearing, and the one nothing pinned: it
    // gates the mtime cache. Persisting the cache after a failed commit records
    // the file at its current mtime, the next run skips it as unchanged, and it
    // stays missing from the graph until a --force — a worse bug than the
    // silent success being fixed, and one introduced by splitting the counters.
    expect(ingestCompletedCleanly(0, 1)).toBe(false);
    expect(ingestCompletedCleanly(0, 99)).toBe(false);
  });

  it("is false when files failed to parse", () => {
    expect(ingestCompletedCleanly(1, 0)).toBe(false);
  });

  it("is true only when neither happened", () => {
    expect(ingestCompletedCleanly(0, 0)).toBe(true);
  });
});

describe("describeStitchFailure", () => {
  it("reports incomplete cross-repository relationships without dumping an HTML response", () => {
    const message = describeStitchFailure(new Error("504: <html>\nlarge proxy response"));

    expect(message).toContain("Cross-workspace stitch failed");
    expect(message).toContain("HTTP 504");
    expect(message).toContain("cross-repository relationships may be incomplete");
    expect(message).not.toContain("large proxy response");
  });

  it("does not read a three-digit run elsewhere in the message as a status", () => {
    expect(describeStitchFailure(new Error("connect ECONNREFUSED 127.0.0.1:8090")))
      .toContain("backend request failed");
  });
});

describe("describeStitchSkipped", () => {
  const cooling = "the last stitch was cut off after 62s and may still be running";
  const contended = "another ix run is already stitching http://localhost:8090";

  it("is a Note, not a failure, and leads with the reason", () => {
    const msg = describeStitchSkipped(cooling, "cooling");
    expect(msg.startsWith("Note:")).toBe(true);
    expect(msg).not.toContain("Warning");
    expect(msg).toContain(cooling);
  });

  it("stays short by default, because a cooldown spans many maps", () => {
    // 15 minutes of auto-map hooks, one Note each. The long form printed three
    // sentences of unchanging advice every time.
    const msg = describeStitchSkipped(cooling, "cooling");
    expect(msg.length).toBeLessThan(200);
    expect(msg).not.toContain("ix ingest <root> --force");
  });

  it("gives the remedy under --verbose, and picks it by RULE", () => {
    const cool = describeStitchSkipped(cooling, "cooling", true);
    expect(cool).toContain("Once the cooldown expires");
    expect(cool).toContain("ix ingest <root> --force");
    expect(cool).toContain("Source patches were committed");

    const busy = describeStitchSkipped(contended, "in-flight", true);
    expect(busy).toContain("may be registering a different workspace");
    expect(busy).not.toContain("Once the cooldown expires");
  });
});

describe("isStitchUnsupported", () => {
  it.each([404, 501])("treats %d as a backend that does not implement stitch", (status) => {
    expect(isStitchUnsupported(new Error(`${status}: Not Found`))).toBe(true);
  });

  it.each([500, 502, 504])("treats %d as a real failure worth surfacing", (status) => {
    expect(isStitchUnsupported(new Error(`${status}: upstream timeout`))).toBe(false);
  });

  it("treats a transport error with no status as a real failure", () => {
    expect(isStitchUnsupported(new Error("connect ECONNREFUSED 127.0.0.1:8090"))).toBe(false);
  });
});
