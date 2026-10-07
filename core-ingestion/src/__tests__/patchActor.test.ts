// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it } from "vitest";
import { patchActor } from "../patch-builder.js";

describe("patchActor", () => {
  const saved = process.env.IX_PATCH_ACTOR;
  afterEach(() => {
    if (saved === undefined) delete process.env.IX_PATCH_ACTOR;
    else process.env.IX_PATCH_ACTOR = saved;
  });

  it("defaults to ix/ingestion for local/OSS backends", () => {
    delete process.env.IX_PATCH_ACTOR;
    expect(patchActor()).toBe("ix/ingestion");
  });

  it("sends an empty actor when IX_PATCH_ACTOR is set to empty, so a cloud backend stamps the verified principal", () => {
    process.env.IX_PATCH_ACTOR = "";
    expect(patchActor()).toBe("");
  });

  it("honours an explicit actor", () => {
    process.env.IX_PATCH_ACTOR = "ci/ingest";
    expect(patchActor()).toBe("ci/ingest");
  });
});
