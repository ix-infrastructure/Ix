import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "test/fixtures/**",
      "scripts/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      // This is a pragmatic, correctness-focused ruleset for a shipping CLI, not
      // a style police. Formatting is owned by Prettier (eslint-config-prettier
      // disables all stylistic rules above).
      "@typescript-eslint/no-explicit-any": "off",

      // Dead imports are auto-removable and always blocked: this is the rule
      // that stops new unused-code rot (e.g. the dead helper found in #272).
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",

      // Pre-existing tech debt, set to warn as a tracked burn-down so this CI
      // PR stays focused (blocking on them would force a 13-file refactor here).
      // New code is still held to the recommended error rules above.
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-useless-assignment": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",

      // Empty catch blocks are an intentional best-effort pattern throughout the
      // CLI (chmod on exotic FS, optional backend calls, etc.).
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Control-character regexes are legitimate when sanitizing terminal output.
      "no-control-regex": "off",
    },
  },
  {
    // Tests exercise odd shapes deliberately; relax the strictest type rules.
    files: ["src/**/__tests__/**", "test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
