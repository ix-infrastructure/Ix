// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { parsePoolSize } from "../commands/ingest.js";

describe("parsePoolSize", () => {
  it("gives a one-file edit one worker, however many cores there are", () => {
    expect(parsePoolSize(1, 24, undefined)).toBe(1);
    expect(parsePoolSize(50, 24, undefined)).toBe(1);
    expect(parsePoolSize(51, 24, undefined)).toBe(2);
  });

  it("caps a large run at 8 by default, or at IX_PARSE_WORKERS", () => {
    expect(parsePoolSize(10_000, 24, undefined)).toBe(8);
    expect(parsePoolSize(10_000, 24, "16")).toBe(16);
    expect(parsePoolSize(10_000, 24, "2")).toBe(2);
  });

  it("never exceeds the cores less one, and never drops below one", () => {
    expect(parsePoolSize(10_000, 4, "16")).toBe(3);
    expect(parsePoolSize(10_000, 2, undefined)).toBe(1);
    expect(parsePoolSize(10_000, 1, undefined)).toBe(1);
    expect(parsePoolSize(0, 24, undefined)).toBe(1);
  });

  it("ignores an IX_PARSE_WORKERS that is not a positive integer", () => {
    for (const bad of ["0", "-3", "1.5", "lots", ""]) {
      expect(parsePoolSize(10_000, 24, bad), bad).toBe(8);
    }
  });
});
