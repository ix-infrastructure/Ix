import { describe, expect, it } from "vitest";

import { shouldOfferBackendUpgrade } from "../commands/upgrade.js";

/**
 * The nag said "Backend update available" on every command while `ix doctor`,
 * two checks later, said the container was running the released image. Both
 * read the same machine; only one of them asked it.
 *
 * `.backend-version` is written by `ix upgrade` and by nothing else, so anyone
 * who pulled through docker compose — or through `ix docker start` after the
 * tag moved — keeps a file that names an old version while running the current
 * image. The reverse is worse: a current file in front of a stale container
 * reports "up to date" while the graph is being served by an old build.
 */
describe("shouldOfferBackendUpgrade", () => {
  it("stays quiet when the running container is already the released image", () => {
    // The reported case: tracked file says 1.0.13, container digest is :latest.
    expect(shouldOfferBackendUpgrade("1.0.16", "1.0.13", "ok")).toBe(false);
  });

  it("still offers the upgrade when the container is genuinely behind", () => {
    expect(shouldOfferBackendUpgrade("1.0.16", "1.0.13", "digest-mismatch")).toBe(true);
  });

  it("keeps the tracked version as the answer when the image cannot be checked", () => {
    // Docker absent, no container, or :latest never pulled: none of these prove
    // the file wrong, so the notice behaves as it always did.
    for (const kind of ["docker-unavailable", "not-running", "latest-not-pulled"] as const) {
      expect(shouldOfferBackendUpgrade("1.0.16", "1.0.13", kind)).toBe(true);
    }
  });

  it("offers the upgrade to someone running a local build", () => {
    // A local build is not the released image, whatever the file says.
    expect(shouldOfferBackendUpgrade("1.0.16", "1.0.13", "local-build")).toBe(true);
  });

  it("says nothing when the tracked version is already current", () => {
    // The common path, and the one that must never reach docker at all.
    expect(shouldOfferBackendUpgrade("1.0.16", "1.0.16", "digest-mismatch")).toBe(false);
    expect(shouldOfferBackendUpgrade("1.0.16", "1.0.17", "digest-mismatch")).toBe(false);
  });

  it("says nothing when no backend release is known", () => {
    expect(shouldOfferBackendUpgrade(undefined, "0.0.0", "docker-unavailable")).toBe(false);
  });

  it("offers the first install, where nothing is tracked yet", () => {
    // `getTrackedVersion` returns 0.0.0 when the file is absent.
    expect(shouldOfferBackendUpgrade("1.0.16", "0.0.0", "not-running")).toBe(true);
  });
});
