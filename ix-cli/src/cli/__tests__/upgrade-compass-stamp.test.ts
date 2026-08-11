import { describe, expect, it } from "vitest";

import { isNewer, parseCompassStamp, shouldOfferCompassUpgradeFor } from "../commands/upgrade.js";

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
   * The numbers `isNewer` was being handed before the marker existed. It says
   * "upgrade", which is how a compass built from system-compass main at Ix
   * release time would have been replaced by an older dist build.
   */
  it("shows what isNewer alone answers across the two series", () => {
    // The moment ix-compass-dist tags anything above the running Ix version.
    expect(isNewer("1.0.0", "0.9.3")).toBe(true);
  });
});

/**
 * The decision itself, which is what #376 actually changes. Asserting on
 * parseCompassStamp alone does not reach it: with these cases absent, deleting
 * the `source === "release"` branch left all 728 tests green while restoring
 * the inversion in full.
 */
describe("shouldOfferCompassUpgradeFor", () => {
  it("never replaces a release bundle with a dist build", () => {
    // The exact inversion. dist has tagged 1.0.0, above the running Ix version,
    // so a bare isNewer() would say yes and downgrade a newer bundled compass.
    expect(
      shouldOfferCompassUpgradeFor("1.0.0", { source: "release", version: "0.9.3" }),
    ).toBe(false);

    // Still no, even for a dist release far ahead — the series never converge.
    expect(
      shouldOfferCompassUpgradeFor("9.9.9", { source: "release", version: "0.9.3" }),
    ).toBe(false);
  });

  it("still compares within the dist series", () => {
    expect(shouldOfferCompassUpgradeFor("0.4.0", { source: "dist", version: "0.3.0" })).toBe(true);
    expect(shouldOfferCompassUpgradeFor("0.3.0", { source: "dist", version: "0.3.0" })).toBe(false);
    expect(shouldOfferCompassUpgradeFor("0.2.0", { source: "dist", version: "0.3.0" })).toBe(false);
  });

  it("keeps the repair path for a missing or gutted bundle", () => {
    // 0.0.0 is what installedCompass() reports when index.html is absent. The
    // repair must fire for a *release* bundle too, which is why the version
    // check sits ahead of the source check rather than after it — reversing
    // them is the regression that breaks `ix view` permanently (#365/#366).
    expect(
      shouldOfferCompassUpgradeFor("0.3.0", { source: "release", version: "0.0.0" }),
    ).toBe(true);
    expect(shouldOfferCompassUpgradeFor("0.3.0", { source: "dist", version: "0.0.0" })).toBe(true);
  });

  it("offers nothing when the dist release is unknown", () => {
    // fetchLatestRelease returned nothing — offline, or the repo moved.
    expect(shouldOfferCompassUpgradeFor(undefined, { source: "dist", version: "0.3.0" })).toBe(
      false,
    );
    expect(shouldOfferCompassUpgradeFor("", { source: "dist", version: "0.0.0" })).toBe(false);
  });

  it("treats a legacy bare stamp as dist-series, as it always was", () => {
    // Everything shipped up to v0.9.2. install.sh wrote the dist number here,
    // which is the majority of installs in the wild.
    const legacy = parseCompassStamp("0.2.0");
    expect(shouldOfferCompassUpgradeFor("0.3.0", legacy)).toBe(true);
  });
});
