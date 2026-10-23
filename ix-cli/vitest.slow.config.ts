// Copyright 2026 Ix Infrastructure Inc.

import { defineConfig } from "vitest/config";

// Slow tests (`*.slow.test.ts`): scale runs (today one 5k-file ingest that
// takes seconds) kept out of the default config (`npm run test:unit`,
// coverage) by its exclude list and run with `npm run test:slow`. Not wired
// into CI. Files run one at a time so their wall-time and RSS readings are
// not each other's noise; the timeout leaves room for slow machines.
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.slow.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
