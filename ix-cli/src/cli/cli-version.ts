// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI's version from its own package.json, `0.0.0` when unreadable. One
 * reader for `ix --version` (`run-cli.ts`) and `ix capabilities`, so the two
 * cannot disagree; node built-ins only, as both load it on their fast paths.
 */
export function readCliVersion(): string {
  try {
    // src/cli/ and dist/cli/ both sit two levels below package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
