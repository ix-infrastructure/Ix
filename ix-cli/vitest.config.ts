import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // vitest 4 dropped `dist/` from its built-in exclude list. Without this the
    // compiled `dist/**/*.test.js` copies emitted by `npm run build` get
    // collected and fail (they read sibling `.ts` sources that only exist under
    // `src/`). Re-exclude it. parser.test.ts is run separately via
    // `test/parser.smoke.mjs`, so keep it out of the default `vitest run`.
    exclude: [...configDefaults.exclude, "dist/**", "test/parser.test.ts"],
  },
});
