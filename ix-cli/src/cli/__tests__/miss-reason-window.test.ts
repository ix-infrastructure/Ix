// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { windowPattern } from "../miss-reason.js";

describe("windowPattern", () => {
  it("matches the name as a word, with context either side", () => {
    const re = new RegExp(windowPattern("redrivePolicy"));
    expect(re.test("  redrivePolicy: { maxReceiveCount: 3 }")).toBe(true);
    expect(re.test("const redrivePolicyArn = x")).toBe(false);
  });

  it("treats every regex metacharacter in the name literally", () => {
    for (const name of ["a.b", "a*b", "a+b", "a?b", "a(b)", "a[b]", "a{1}", "a|b", "a^b", "a$b", "a\\b"]) {
      const re = new RegExp(windowPattern(name));
      expect(re.test(` ${name} `), name).toBe(true);
    }
    expect(new RegExp(windowPattern("a.b")).test(" axb ")).toBe(false);
    expect(new RegExp(windowPattern("a|b")).test(" a ")).toBe(false);
  });
});
