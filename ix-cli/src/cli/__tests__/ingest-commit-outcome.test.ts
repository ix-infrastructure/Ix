import { describe, expect, it } from "vitest";

import { describeCommitOutcome } from "../commands/ingest.js";

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
    expect(describeCommitOutcome(-1, 10)).toEqual({ kind: "ok" });
  });
});
