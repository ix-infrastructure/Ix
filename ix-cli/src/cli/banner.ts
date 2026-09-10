// Copyright 2026 Ix Infrastructure INC

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type RenderLogo = typeof import("../../scripts/render-logo.mjs")["renderLogo"];

/**
 * The Ix logo as a terminal banner, rendered at print time from the packaged
 * assets/logo.png by the zero-dependency renderer in scripts/render-logo.mjs —
 * imported in-process (no subprocess, no spawn cost). The PNG is the only
 * maintained art; the terminal render is derived from it.
 *
 * Contract (mirrors emitSetupNotice):
 * - stderr-only surface: this returns a string for the caller to emit to
 *   stderr; it never writes to stdout (machine-readable output stays clean).
 * - absent-safe: a layout that did not ship the renderer or the asset is NOT
 *   an error — the loader below resolves to null and emitSetupNotice falls
 *   back to the plain text heading. The banner is decoration, never
 *   load-bearing. This is why the import is dynamic behind a probe: a static
 *   import of the renderer would crash this module at load time in any layout
 *   that copied dist/ without scripts/ + assets/ (e.g. the watch child
 *   runtime cache), turning a missing decoration into a broken CLI.
 * - honors NO_COLOR / TERM=dumb (the renderer itself resolves the mode): the
 *   no-color path renders the ASCII fallback, also fine to show.
 *
 * Where the inputs live: scripts/ + assets/ inside the package, beside the
 * compiled dist/cli/banner.js. The ESM specifier resolves relative to this
 * file identically in every layout that ships them — repo checkout, npm
 * tarball, and the release staging tree (which copies them explicitly, gated
 * in release.yml; the npm tarball is pinned by a test in
 * bootstrap-notice.test.ts). The probe checks the same package-relative
 * location, so it can only disagree with the import if the files vanish
 * between probe and import — in which case the catch degrades to null.
 */
let renderLogoFn: RenderLogo | null = null;
try {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (
    existsSync(join(pkgDir, "scripts", "render-logo.mjs")) &&
    existsSync(join(pkgDir, "assets", "logo.png"))
  ) {
    renderLogoFn = (await import("../../scripts/render-logo.mjs")).renderLogo;
  }
} catch {
  renderLogoFn = null;
}

let cache: string | null | undefined;

export function renderBanner(): string | null {
  // The setup notice prints at most once per run; the module-level cache makes
  // a second call free without repeating the decode (~10ms in-process vs the
  // subprocess + interpreter startup this replaced).
  if (cache !== undefined) return cache;
  if (!renderLogoFn) return (cache = null);

  try {
    const out = renderLogoFn({ width: 48, color: "auto" });
    // renderLogo returns the ANSI string (or a JSON block when asked — never
    // here). A render that produced no visible cells would silently corrupt
    // the notice block; treat either as failure and fall back.
    if (typeof out !== "string" || !out.trim()) return (cache = null);

    // Indent the banner to align with the notice text block.
    cache = out
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l.trim() ? `  ${l}` : l))
      .join("\n");
  } catch {
    cache = null; // any decode/unsupported-asset failure: plain-text fallback
  }
  return cache;
}

/** Test hook: reset the memoized banner result. */
export function resetBannerCacheForTests(): void {
  cache = undefined;
}
