// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_FEATURES,
  MIN_BACKEND_VERSION,
  backendBelowMinimum,
  fallbackRemovable,
  featureOff,
  httpStatus,
  markFeatureOff,
  missingFeatures,
  releaseAtLeast,
  routeMissing,
  type BackendFeature,
} from "../features.js";

describe("httpStatus", () => {
  it("reads the status IxClient puts at the front of its error", () => {
    expect(httpStatus(new Error("404: not found"))).toBe(404);
    expect(httpStatus("Error: 501: Not Implemented")).toBe(501);
  });

  it("never reads a three-digit run from anywhere but the front", () => {
    expect(httpStatus(new Error("connect ECONNREFUSED 127.0.0.1:404"))).toBeNull();
    expect(httpStatus(new Error("500: upstream said 404: Not Found"))).toBe(500);
    expect(httpStatus(undefined)).toBeNull();
  });
});

describe("routeMissing", () => {
  // The statuses each call site treated as "this backend has no such route"
  // before the decision moved here. Changing one is a behaviour change.
  const cases: Array<[BackendFeature, number[], number[]]> = [
    ["batchNodes", [404, 405, 501], [400, 413, 500, 502, 503]],
    ["degree", [404, 405], [400, 413, 500, 501, 503]],
    ["stitch", [404, 501], [400, 405, 500, 502, 504]],
    ["workspaceSystem", [404], [400, 405, 500, 501, 503]],
    ["asyncReset", [404], [400, 405, 500, 501, 503]],
  ];

  it.each(cases)("%s: missing on %j, present otherwise", (feature, missing, present) => {
    for (const status of missing) {
      expect(routeMissing(feature, new Error(`${status}: x`))).toBe(true);
      expect(routeMissing(feature, status)).toBe(true);
    }
    for (const status of present) {
      expect(routeMissing(feature, new Error(`${status}: x`))).toBe(false);
      expect(routeMissing(feature, status)).toBe(false);
    }
  });

  it("is false for a transport failure or a body that merely mentions a status", () => {
    expect(routeMissing("stitch", new Error("fetch failed"))).toBe(false);
    // A proxy answering 200 with an HTML page titled "404: Not Found" (#528).
    expect(routeMissing("stitch", new Error("200: response body is not JSON: <title>404: Not Found"))).toBe(false);
  });

  it("is false for a feature detected by release rather than by probing", () => {
    expect(routeMissing("bulkDeletes", 404)).toBe(false);
    expect(routeMissing("searchScope", new Error("404: x"))).toBe(false);
  });
});

describe("featureOff / markFeatureOff", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("remembers per feature and per endpoint, until the TTL passes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = "http://a.example:8090";
    const b = "http://b.example:8090";
    markFeatureOff("degree", a, 1000);
    expect(featureOff("degree", a)).toBe(true);
    expect(featureOff("degree", b)).toBe(false);
    expect(featureOff("batchNodes", a)).toBe(false);
    vi.advanceTimersByTime(999);
    expect(featureOff("degree", a)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(featureOff("degree", a)).toBe(false);
  });
});

describe("releaseAtLeast", () => {
  it("compares major, minor and patch numerically", () => {
    expect(releaseAtLeast("1.0.33", "1.0.33")).toBe(true);
    expect(releaseAtLeast("v1.0.34", "1.0.33")).toBe(true);
    expect(releaseAtLeast("1.0.9", "1.0.10")).toBe(false);
    expect(releaseAtLeast("2.0.0", "1.9.99")).toBe(true);
  });

  it("is null when the backend reports no release, or one that does not parse", () => {
    expect(releaseAtLeast(undefined, "1.0.0")).toBeNull();
    expect(releaseAtLeast("dev", "1.0.0")).toBeNull();
    expect(releaseAtLeast(42, "1.0.0")).toBeNull();
  });
});

describe("MIN_BACKEND_VERSION", () => {
  it("is a plain release number", () => {
    expect(MIN_BACKEND_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("backendBelowMinimum compares a reported release with it", () => {
    expect(backendBelowMinimum(MIN_BACKEND_VERSION)).toBe(false);
    expect(backendBelowMinimum("0.0.1")).toBe(true);
    expect(backendBelowMinimum("99.0.0")).toBe(false);
    expect(backendBelowMinimum(undefined)).toBeNull();
  });

  it("no feature whose fallback the CLI still carries is already removable", () => {
    // Raising MIN_BACKEND_VERSION past a feature's `since` makes this fail:
    // delete that fallback (see the feature's `fallbackAt`) and its entry, or
    // set `since` to null if the feature stays optional for another reason.
    for (const feature of Object.keys(BACKEND_FEATURES) as BackendFeature[]) {
      expect(fallbackRemovable(feature), feature).not.toBe(true);
    }
  });
});

describe("BACKEND_FEATURES", () => {
  it("names, for every feature, where its fallback lives and when it can go", () => {
    for (const [name, spec] of Object.entries(BACKEND_FEATURES)) {
      expect(spec.fallbackAt, name).toMatch(/\.ts$/);
      expect(spec.fallback.length, name).toBeGreaterThan(0);
      if (spec.since !== null) expect(spec.since, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("missingFeatures lists what a reported release lacks, and nothing for an unknown release", () => {
    expect(missingFeatures("1.0.32")).toEqual(expect.arrayContaining(["batchNodes", "degree", "databaseHealth"]));
    expect(missingFeatures("1.0.32")).not.toContain("bulkDeletes");
    expect(missingFeatures("1.0.33")).toEqual([]);
    expect(missingFeatures(undefined)).toEqual([]);
  });
});
