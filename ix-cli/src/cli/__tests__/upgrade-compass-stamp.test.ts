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
    expect(parseCompassStamp("0.9.3+release.7f98724\n")).toEqual({
      source: "release",
      version: "0.9.3",
    });
    // install.sh/install.ps1 have no commit to record, so they write the marker
    // without one.
    expect(parseCompassStamp("0.9.3+release\n")).toEqual({
      source: "release",
      version: "0.9.3",
    });
  });

  it("reads a bare number as dist-series", () => {
    // Both the legacy stamp (everything up to v0.9.2, where install.sh wrote the
    // dist release — the majority of installs in the wild) and the dist form
    // going forward. Reading it as dist keeps those exactly as correct as they
    // already were, and needs no marker.
    expect(parseCompassStamp("0.3.0")).toEqual({ source: "dist", version: "0.3.0" });
    expect(parseCompassStamp(" 0.2.0\n")).toEqual({ source: "dist", version: "0.2.0" });
  });

  it("treats build metadata that is not `release` as dist", () => {
    expect(parseCompassStamp("0.3.0+dist")).toEqual({ source: "dist", version: "0.3.0" });
    expect(parseCompassStamp("0.3.0+abc123")).toEqual({ source: "dist", version: "0.3.0" });
  });

  it("treats an empty or unparseable stamp as absent", () => {
    expect(parseCompassStamp("")).toEqual({ source: "dist", version: "0.0.0" });
    expect(parseCompassStamp("   \n  ")).toEqual({ source: "dist", version: "0.0.0" });
    expect(parseCompassStamp("+release")).toEqual({ source: "dist", version: "0.0.0" });
  });

  it("tolerates CRLF, which is how a Windows bundle arrives", () => {
    expect(parseCompassStamp("0.9.3+release.7f98724\r\n")).toEqual({
      source: "release",
      version: "0.9.3",
    });
  });

  it("reads only the first line, so a stray second one cannot poison the version", () => {
    expect(parseCompassStamp("0.9.3+release.7f98724\ntrailing junk\n")).toEqual({
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
 * `compass/.version` has readers we cannot upgrade. Every already-shipped CLI
 * reads it with `getTrackedVersion` — `readFileSync(...).trim()`, the WHOLE
 * file — and hands that straight to `splitVersion`/`isNewer`. The upgrade
 * sequence puts the new stamp in front of the old reader: `ix upgrade` swaps in
 * the new tree, then the still-running old process continues into its own
 * compass block and reads the file it just installed.
 *
 * A multi-line `key=value` stamp made that blob's major parse as
 * `Number("source=release\nix=1")` = NaN -> 0, so an old CLI saw a 1.x release
 * as [0,0,0] and downloaded ix-compass-dist over the newer bundle — Ix#376
 * reintroduced by the format change itself. These cases pin the property that
 * prevents it: whatever the stamp carries, an old reader must still see a
 * version that compares correctly.
 */
describe("legacy readers survive the stamp format", () => {
  // Verbatim getTrackedVersion from the shipped CLI.
  const legacyRead = (raw: string) => raw.trim() || "0.0.0";

  it("never offers a dist downgrade to an old CLI, at any release number", () => {
    for (const ix of ["0.9.3", "0.9.4", "1.0.0", "1.1.0", "2.5.3"]) {
      const onDisk = legacyRead(`${ix}+release.7f98724\n`);
      expect(isNewer("0.3.0", onDisk)).toBe(false);
    }
  });

  it("keeps the whole stamp on one line", () => {
    // The property the loop above depends on. A second line puts the newline
    // inside splitVersion's input and the major becomes NaN -> 0.
    const stamp = "1.0.0+release.7f98724\n";
    expect(legacyRead(stamp)).not.toContain("\n");

    // What the rejected multi-line form would have done, for contrast.
    const multiline = legacyRead("source=release\nix=1.0.0\ncompass=7f98724\n");
    expect(isNewer("0.3.0", multiline)).toBe(true);
  });

  it("still lets an old CLI upgrade a genuine dist bundle", () => {
    expect(isNewer("0.4.0", legacyRead("0.3.0\n"))).toBe(true);
  });
});

/**
 * The decision itself, which is what #376 actually changes. Asserting on
 * parseCompassStamp alone does not reach it: with these cases absent, deleting
 * the `source === "release"` branch left all 728 tests green while restoring
 * the inversion in full.
 */
describe("shouldOfferCompassUpgradeFor", () => {
  const onDisk = (raw: string) => ({ ...parseCompassStamp(raw), present: true });

  it("never replaces a release bundle with a dist build", () => {
    // The exact inversion. dist has tagged 1.0.0, above the running Ix version,
    // so a bare isNewer() would say yes and downgrade a newer bundled compass.
    expect(shouldOfferCompassUpgradeFor("1.0.0", onDisk("0.9.3+release.7f98724"))).toBe(false);

    // Still no, even for a dist release far ahead — the series never converge.
    expect(shouldOfferCompassUpgradeFor("9.9.9", onDisk("0.9.3+release.7f98724"))).toBe(false);
  });

  it("still compares within the dist series", () => {
    expect(shouldOfferCompassUpgradeFor("0.4.0", onDisk("0.3.0"))).toBe(true);
    expect(shouldOfferCompassUpgradeFor("0.3.0", onDisk("0.3.0"))).toBe(false);
    expect(shouldOfferCompassUpgradeFor("0.2.0", onDisk("0.3.0"))).toBe(false);
  });

  it("keeps the repair path for a missing or gutted bundle", () => {
    // present=false is what installedCompass() reports when index.html is
    // absent. The repair must fire for a *release* bundle too, which is why the
    // present check sits ahead of the source check rather than after it —
    // reversing them breaks `ix view` permanently (#365/#366).
    expect(
      shouldOfferCompassUpgradeFor("0.3.0", { source: "release", version: "0.9.3", present: false }),
    ).toBe(true);
    expect(
      shouldOfferCompassUpgradeFor("0.3.0", { source: "dist", version: "0.3.0", present: false }),
    ).toBe(true);
  });

  it("does not 'repair' a present release bundle whose stamp is damaged", () => {
    // The reason `present` is carried separately instead of being encoded as
    // version 0.0.0: a stamp truncated by a full disk or a kill during the
    // non-atomic write also parses as 0.0.0. The bundle beside it is intact and
    // serving, so replacing it with an older dist build is the #376 downgrade
    // reached through a corrupt file instead of a version comparison.
    expect(
      shouldOfferCompassUpgradeFor("0.3.0", { source: "release", version: "0.0.0", present: true }),
    ).toBe(false);
  });

  it("offers nothing when the dist release is unknown", () => {
    // fetchLatestRelease returned nothing — offline, or the repo moved.
    expect(shouldOfferCompassUpgradeFor(undefined, onDisk("0.3.0"))).toBe(false);
    expect(shouldOfferCompassUpgradeFor("", onDisk("0.3.0"))).toBe(false);
  });

  it("treats a legacy bare stamp as dist-series, as it always was", () => {
    // Everything shipped up to v0.9.2. install.sh wrote the dist number here,
    // which is the majority of installs in the wild.
    expect(shouldOfferCompassUpgradeFor("0.3.0", onDisk("0.2.0"))).toBe(true);
  });
});
