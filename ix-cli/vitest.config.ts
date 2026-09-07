import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // vitest 4 dropped `dist/` from its built-in exclude list. Without this the
    // compiled `dist/**/*.test.js` copies emitted by `npm run build` get
    // collected and fail (they read sibling `.ts` sources that only exist under
    // `src/`). Re-exclude it. parser.test.ts is run separately via
    // `test/parser.smoke.mjs`, so keep it out of the default `vitest run`.
    exclude: [...configDefaults.exclude, "dist/**", "test/parser.test.ts"],
    // Sized for what this suite actually DOES, not for unit tests.
    //
    // Vitest defaults to 5s per test and 10s per hook, which suits pure
    // functions. Twenty-plus files here spawn real child processes, start real
    // HTTP servers, run a worker-thread parse pool, shell out to `tar`, and
    // mkdtemp real trees. On an idle machine those take 1-6s; under the full
    // suite's parallelism on a loaded runner they take several times that, and
    // whichever test is running when the runner is busiest fails on the clock
    // rather than on an assertion.
    //
    // Three separate files did exactly that in one day: ingest-files (1 of 4
    // runs, 3 of 3 under added load), watch-dedup (35.7s against its own 30s
    // budget), and upgrade-compass-bundle (6356ms against the 5s default, on a
    // PR whose only change was a YAML file). Each read as a real regression on
    // whichever leg happened to be slowest.
    //
    // 20s is not arbitrary -- it is what this codebase already chose, fifteen
    // separate times, as the explicit budget for tests of exactly this shape.
    // Making it the default is what stops the next one being written without
    // it: only 5 of 98 files carry an explicit timeout today, while more than
    // twenty do real I/O.
    //
    // Raising the default does not weaken anything, and that is worth stating
    // because it is the obvious objection. Two reasons:
    //
    //   - No test depends on a short timeout. The ones that care about not
    //     waiting forever assert on the CLOCK instead --
    //     `expect(elapsed).toBeLessThan(ParsePool.SHUTDOWN_GRACE_MS * 4)` --
    //     and parse-pool's comment says outright that its timeout exists only
    //     so the failure carries an explanation. Those assertions are
    //     unaffected by what the budget is.
    //   - An explicit third argument still wins. Verified rather than assumed:
    //     with `shutdown` mutated never to settle, that test failed at its own
    //     15000ms, not at this 20000.
    //
    // The cost is real but small: a genuinely hung test now reports 15s later
    // than it used to, on a suite that runs in ~70s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      // Reporters: text for the CI log, json/html as the uploaded artifact.
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.d.ts"],
      // Floor set just below the current baseline (measured across ALL src files,
      // not just tested ones) so it catches regressions without flaking. Ratchet
      // these up as coverage improves; never lower.
      thresholds: {
        statements: 22,
        branches: 21,
        functions: 28,
        lines: 23,
      },
    },
  },
});
