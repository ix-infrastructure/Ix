// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { githubCommitFailure } from "../commands/ingest.js";
import { canPollInstead } from "../commands/watch.js";

describe("ix map --github after the base-rev retries", () => {
  it("is a failure when the last attempt still lost the race: nothing was written", () => {
    expect(githubCommitFailure({ status: "BaseRevMismatch" })).toMatch(/nothing was ingested/);
  });

  it("is a success otherwise", () => {
    for (const status of ["Ok", "Idempotent", undefined]) {
      expect(githubCommitFailure({ status })).toBeUndefined();
    }
  });
});

describe("ix watch falls back to polling", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it("when recursive watching is unavailable, or the OS is out of watches or descriptors", () => {
    for (const code of ["ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "ENOSPC", "EMFILE", "ENFILE"]) {
      expect(canPollInstead(err(code)), code).toBe(true);
    }
  });

  it("but not for a real error such as a permission problem", () => {
    for (const code of ["EACCES", "EPERM"]) expect(canPollInstead(err(code)), code).toBe(false);
    expect(canPollInstead(new Error("boom"))).toBe(false);
    expect(canPollInstead(undefined)).toBe(false);
  });
});
