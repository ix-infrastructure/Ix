import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Ix logo as a terminal banner, rendered at print time from the repo's own
 * assets/logo.png by scripts/render-logo.mjs (zero deps). The PNG is the only
 * maintained art; the terminal render is derived from it on every run.
 *
 * Contract (mirrors emitSetupNotice):
 * - stderr-only surface: this returns a string for the caller to emit to
 *   stderr; it never writes to stdout (machine-readable output stays clean).
 * - absent-safe: the renderer or the asset missing from an install layout is
 *   NOT an error — returns null and emitSetupNotice falls back to the plain
 *   text heading. The banner is decoration, never load-bearing.
 * - honors NO_COLOR / TERM=dumb (the renderer itself resolves the mode): the
 *   no-color path renders the ASCII fallback, also fine to show.
 */
let cache: string | null | undefined;

export function renderBanner(): string | null {
  // The setup notice prints at most once per run; the module-level cache makes
  // a second call free without repeating the subprocess spawn.
  if (cache !== undefined) return cache;

  try {
    // dist/cli/banner.js -> package root is three levels up; src/cli/banner.ts
    // running under tsx has the same shape. Both sit beside scripts/ + assets/.
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..", "..", "..");
    const renderer = join(root, "scripts", "render-logo.mjs");
    const asset = join(root, "assets", "logo.png");
    if (!existsSync(renderer) || !existsSync(asset)) return (cache = null);

    const out = execFileSync(process.execPath, [renderer, "--width", "48"], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    // The renderer exiting 0 with empty stdout would silently corrupt the
    // notice block; treat empty output as failure and fall back.
    if (!out.trim()) return (cache = null);

    // Indent the banner to align with the notice text block.
    cache = out
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l.trim() ? `  ${l}` : l))
      .join("\n");
  } catch {
    cache = null; // any spawn/timeout failure: plain-text fallback
  }
  return cache;
}

/** Test hook: reset the memoized banner result. */
export function resetBannerCacheForTests(): void {
  cache = undefined;
}
