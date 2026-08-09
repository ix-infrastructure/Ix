import { describe, expect, it } from "vitest";

import { isNewer } from "../commands/upgrade.js";

describe("isNewer", () => {
  it("compares plain releases", () => {
    expect(isNewer("0.9.0", "0.8.1")).toBe(true);
    expect(isNewer("0.8.1", "0.9.0")).toBe(false);
    expect(isNewer("0.9.0", "0.9.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  });

  it("offers the GA release to someone running its release candidate", () => {
    // The regression this exists for. `"0.9.0-rc.1".split(".").map(Number)` is
    // [0, 9, NaN, 1]; NaN lost every comparison and was coerced to 0, so this
    // returned false and RC testers were never told the real release shipped.
    expect(isNewer("0.9.0", "0.9.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true);
  });

  it("does not offer a release candidate to someone already on the GA", () => {
    expect(isNewer("0.9.0-rc.1", "0.9.0")).toBe(false);
  });

  it("orders release candidates against each other", () => {
    expect(isNewer("0.9.0-rc.2", "0.9.0-rc.1")).toBe(true);
    expect(isNewer("0.9.0-rc.1", "0.9.0-rc.2")).toBe(false);
    // Numeric identifiers compare numerically, not as strings — the case a
    // lexical sort gets wrong.
    expect(isNewer("0.9.0-rc.10", "0.9.0-rc.9")).toBe(true);
    expect(isNewer("0.9.0-rc.9", "0.9.0-rc.10")).toBe(false);
  });

  it("follows semver precedence for mixed pre-release identifiers", () => {
    // The ordering example from the semver spec itself.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      const lower = ordered[i]!;
      const higher = ordered[i + 1]!;
      expect(isNewer(higher, lower), `${higher} > ${lower}`).toBe(true);
      expect(isNewer(lower, higher), `${lower} !> ${higher}`).toBe(false);
    }
  });

  it("ignores build metadata, which carries no precedence", () => {
    expect(isNewer("0.9.0+abc123", "0.9.0")).toBe(false);
    expect(isNewer("0.9.1+abc123", "0.9.0")).toBe(true);
  });

  it("does not throw on malformed input", () => {
    // getCurrentVersion falls back to "0.0.0", and a tampered cache is rejected
    // upstream, but this must not be the thing that throws.
    expect(() => isNewer("", "0.9.0")).not.toThrow();
    expect(() => isNewer("not-a-version", "0.9.0")).not.toThrow();
    expect(isNewer("0.9.0", "0.0.0")).toBe(true);
  });
});
