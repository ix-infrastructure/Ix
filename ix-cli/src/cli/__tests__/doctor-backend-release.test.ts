// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { assessBackendRelease } from "../commands/doctor.js";
import { MIN_BACKEND_VERSION } from "../../client/features.js";

describe("assessBackendRelease (Ix#942)", () => {
  it("warns, never fails, when the backend is older than MIN_BACKEND_VERSION", () => {
    const r = assessBackendRelease({ status: "ok", release_version: "1.0.12" });
    expect(r).toMatchObject({ ok: false, warn: true });
    expect(r.detail).toContain(`older than ${MIN_BACKEND_VERSION}`);
    // It names what that release lacks, from the feature table.
    expect(r.detail).toContain("batched node reads");
  });

  it("passes the minimum itself, and names what an old-but-supported release lacks", () => {
    const r = assessBackendRelease({ status: "ok", release_version: MIN_BACKEND_VERSION });
    expect(r.ok).toBe(true);
    expect(r.warn).toBeUndefined();
    expect(r.detail).toContain("degree counts");
  });

  it("lists nothing missing for a current backend", () => {
    expect(assessBackendRelease({ status: "ok", release_version: "1.0.34" }))
      .toEqual({ ok: true, detail: `1.0.34 (this CLI supports ${MIN_BACKEND_VERSION} and later)` });
  });

  it("does not judge a backend that is unreachable or reports no usable release", () => {
    expect(assessBackendRelease(new Error("fetch failed"))).toEqual({ ok: true, detail: "backend unreachable (skipped)" });
    expect(assessBackendRelease({ status: "ok" }).ok).toBe(true);
    expect(assessBackendRelease({ status: "ok", release_version: "dev" }).ok).toBe(true);
  });
});
