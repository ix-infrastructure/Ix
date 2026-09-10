// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";
import { IxClient } from "../src/client/api.js";

describe("IxClient", () => {
  it("should construct with default endpoint", () => {
    const client = new IxClient();
    expect(client).toBeDefined();
  });

  it("should construct with custom endpoint", () => {
    const client = new IxClient("http://localhost:9090");
    expect(client).toBeDefined();
  });
});
