import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // vitest 4 dropped `dist/` from its built-in exclude list. Without this the
    // compiled `dist/**/*.test.js` copies emitted by `npm run build` get
    // collected and fail (they read sibling `.ts` sources that only exist under
    // `src/`). Re-exclude it. parser.test.ts is run separately via
    // `test/parser.smoke.mjs`, so keep it out of the default `vitest run`.
    exclude: [...configDefaults.exclude, "dist/**", "test/parser.test.ts"],
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
