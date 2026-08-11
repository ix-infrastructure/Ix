import { describe, expect, it } from "vitest";

import { isNewer, parseCompassStamp } from "../commands/upgrade.js";

/**
 * Ix#376. `compass/.version` is written by two producers in two unrelated
 * version series — the release workflow stamps the *Ix* version, install.sh and
 * the compass-upgrade path stamp the *ix-compass-dist* release — and the stamp
 * used to record no way to tell them apart. `isNewer(distLatest, stamp)` then
 * compared across series and was correct only while Ix's numbers happened to be
 * the larger ones.
 */
describe("parseCompassStamp", () => {
  it("reads the release form", () => {
    expect(parseCompassStamp("source=release\nix=0.9.3\ncompass=7f98724\n")).toEqual({
      source: "release",
      version: "0.9.3",
    });
  });

  it("reads the dist form", () => {
    expect(parseCompassStamp("source=dist\nversion=0.3.0\n")).toEqual({
      source: "dist",
      version: "0.3.0",
    });
  });

  it("reads a bare legacy number as dist-series", () => {
    // Every stamp shipped up to v0.9.2 is a bare number. install.sh wrote the
    // dist release there, which is the majority of installs in the wild, so
    // reading it as dist keeps those exactly as correct as they already were.
    expect(parseCompassStamp("0.3.0")).toEqual({ source: "dist", version: "0.3.0" });
    expect(parseCompassStamp(" 0.2.0\n")).toEqual({ source: "dist", version: "0.2.0" });
  });

  it("treats an empty or unparseable stamp as absent", () => {
    expect(parseCompassStamp("")).toEqual({ source: "dist", version: "0.0.0" });
    expect(parseCompassStamp("   \n  ")).toEqual({ source: "dist", version: "0.0.0" });
    // A key=value blob with no version field is malformed, not "version 0.0.0
    // of something" — 0.0.0 makes the repair path fire, which is the safe end.
    expect(parseCompassStamp("source=dist\n")).toEqual({ source: "dist", version: "0.0.0" });
  });

  it("tolerates CRLF, which is how a Windows bundle arrives", () => {
    expect(parseCompassStamp("source=release\r\nix=0.9.3\r\n")).toEqual({
      source: "release",
      version: "0.9.3",
    });
  });

  /**
   * The regression itself. Without the source marker these are the numbers
   * `isNewer` was being handed, and it says "upgrade" — replacing a compass
   * built from system-compass main at Ix release time with an older dist build.
   */
  it("pins the inversion the marker exists to prevent", () => {
    // The moment ix-compass-dist tags anything above the running Ix version.
    expect(isNewer("1.0.0", "0.9.3")).toBe(true);

    // With provenance recorded, the comparison is skipped for release bundles
    // rather than being asked a question it cannot answer.
    expect(parseCompassStamp("source=release\nix=0.9.3\n").source).toBe("release");

    // And is still asked, correctly, for a bundle that really came from dist.
    const dist = parseCompassStamp("source=dist\nversion=0.3.0\n");
    expect(dist.source).toBe("dist");
    expect(isNewer("0.4.0", dist.version)).toBe(true);
    expect(isNewer("0.3.0", dist.version)).toBe(false);
  });
});
