// Copyright 2026 Ix Infrastructure Inc.

import { defineConfig } from "vitest/config";

// Real-backend harness (test/e2e). Kept out of `npm test`: its files end in
// .e2e.ts, which the default config's include pattern does not match. Every
// scenario resets one shared database, so files and tests run one at a time.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
