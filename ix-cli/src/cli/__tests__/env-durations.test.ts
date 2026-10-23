// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it } from "vitest";
import { parseNonNegativeIntEnv, parsePositiveIntEnv } from "../commands/ingest.js";
import { mapDeadlineMs } from "../commands/map.js";

// `Number.parseInt` reads any numeric prefix, so a unit suffix or an exponent
// silently became a tiny number: IX_MAP_DEADLINE_MS=15m aborted every map
// after 15 ms, and IX_COMMIT_HTTP_MAX_FILES=1e3 sent one file per request.
describe("mapDeadlineMs", () => {
  it("defaults to 15 minutes when unset", () => {
    expect(mapDeadlineMs(undefined)).toBe(15 * 60 * 1000);
  });

  it("takes a plain number of milliseconds", () => {
    expect(mapDeadlineMs("60000")).toBe(60_000);
  });

  it("is disabled by 0 or an empty value", () => {
    expect(mapDeadlineMs("0")).toBeUndefined();
    expect(mapDeadlineMs("")).toBeUndefined();
  });

  it("keeps the default for a value with a unit rather than reading its prefix", () => {
    expect(mapDeadlineMs("15m")).toBe(15 * 60 * 1000);
    expect(mapDeadlineMs("1e3")).toBe(15 * 60 * 1000);
  });
});

describe("parsePositiveIntEnv", () => {
  const name = "IX_TEST_POSITIVE_INT_ENV";
  afterEach(() => { delete process.env[name]; });

  it("reads a plain positive integer", () => {
    process.env[name] = "250";
    expect(parsePositiveIntEnv(name, 7)).toBe(250);
  });

  it("falls back for a value with a suffix or exponent", () => {
    for (const raw of ["1e3", "2k", "10ms", "-5", "0"]) {
      process.env[name] = raw;
      expect(parsePositiveIntEnv(name, 7), raw).toBe(7);
    }
  });
});

// A count of retries, where 0 is an instruction and not "unset":
// IX_COMMIT_CONFLICT_RETRIES=0 used to retry six times (IN-19C).
describe("parseNonNegativeIntEnv", () => {
  const name = "IX_TEST_NON_NEGATIVE_INT_ENV";
  afterEach(() => { delete process.env[name]; });

  it("reads 0 as 0", () => {
    process.env[name] = "0";
    expect(parseNonNegativeIntEnv(name, 6)).toBe(0);
  });

  it("reads a plain positive integer", () => {
    process.env[name] = "3";
    expect(parseNonNegativeIntEnv(name, 6)).toBe(3);
  });

  it("falls back for unset, empty, a suffix, an exponent or a sign", () => {
    expect(parseNonNegativeIntEnv(name, 6)).toBe(6);
    for (const raw of ["", "1e3", "-1", "2k"]) {
      process.env[name] = raw;
      expect(parseNonNegativeIntEnv(name, 6), raw).toBe(6);
    }
  });
});
