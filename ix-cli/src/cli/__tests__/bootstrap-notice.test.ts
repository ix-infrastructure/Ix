// Copyright 2026 Ix Infrastructure INC

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitSetupNotice } from "../bootstrap.js";
import { renderBanner, resetBannerCacheForTests } from "../banner.js";
import { renderLogo, resolveColorMode, LogoError } from "../../../scripts/render-logo.mjs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// The renderer + asset now live INSIDE the package (fix for the review
// finding that the first banner PR shipped them at the repo root, where no
// install layout — npm tarball or release staging — ever carried them). These
// bases serve both the behavioral pins below and the deliverability pin.
const PKG_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", ".."); // ix-cli/
const RENDERER = join(PKG_ROOT, "scripts", "render-logo.mjs");
const LOGO_ASSET = join(PKG_ROOT, "assets", "logo.png");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetBannerCacheForTests();
});

describe("emitSetupNotice", () => {
  it("writes setup notices to stderr, never stdout (keeps machine output clean)", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    emitSetupNotice(true, true, "my-workspace");

    // The bug this guards: the banner leaked to stdout and corrupted --format json|llm.
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderrText).toContain("Registered workspace");
    expect(stderrText).toContain("my-workspace");
  }, 15000);

  it("shows the logo banner when the renderer + asset are present", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    emitSetupNotice(true, false, "ws");

    expect(out).not.toHaveBeenCalled();
    const banner = renderBanner();
    expect(banner).not.toBeNull();
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("\n");
    // (whatever color mode this environment resolves), not the text fallback.
    expect(stderrText).toContain(banner!);
    expect(stderrText).not.toContain("Ix");
  }, 15000);

  it("falls back to the plain text heading when the asset is absent (absent-safe)", () => {
    // A layout without the packaged asset must degrade to the old heading —
    // never throw, never leave the notice block empty. The renderer reads the
    // asset at call time, so renaming it exercises exactly that layout.
    // Within-file tests run sequentially, so the temporary rename is invisible
    // to the other pins (and afterEach resets the banner cache).
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const assetBackup = LOGO_ASSET + ".bak";
    renameSync(LOGO_ASSET, assetBackup);
    try {
      emitSetupNotice(true, false, "ws");
      const stderrText = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(stderrText).toContain("Ix");
      expect(stderrText).not.toContain("▀");
    } finally {
      renameSync(assetBackup, LOGO_ASSET);
    }
    expect(out).not.toHaveBeenCalled();
  });
});

describe("renderBanner", () => {
  it("returns a non-empty banner containing half-block cells", () => {
    // renderBanner() spawns the renderer with the inherited env; CI runners
    // may have TERM unset/dumb (resolving to the ASCII fallback, which has no
    // half-blocks). Pin the environment so this always exercises the color
    // path — the assertion itself stays exact.
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("COLORTERM", "");
    const banner = renderBanner();
    expect(banner).not.toBeNull();
    expect(banner!.includes("▀")).toBe(true);
    // every non-empty line indented two spaces for the notice block
    // (a leading blank line is intentional spacing)
    for (const line of banner!.split("\n")) {
      if (line.trim()) expect(line.startsWith("  ")).toBe(true);
    }
  }, 15000);

  it("renders ASCII under NO_COLOR and never writes stdout", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const raw = execFileSync(
      process.execPath,
      [RENDERER, "--width", "16"],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(raw).not.toMatch(/\x1b\[/); // no escapes in no-color mode
    expect(out).not.toHaveBeenCalled();
  });
});

describe("banner deliverability (the inputs must ship)", () => {
  // History: the first banner PR kept scripts/render-logo.mjs + assets/logo.png
  // at the repo ROOT — a layout no delivery path packs (npm publishes from
  // ix-cli/; release staging copies exactly three trees) — so every installed
  // run silently fell back to the plain heading while all tests (run from a
  // checkout, where the files exist) passed. These pins turn that failure loud
  // at PR time: if the inputs leave the package or the staging tree, CI fails.

  it("npm pack carries the renderer and the asset inside the tarball", () => {
    const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PKG_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(res.status).toBe(0);
    const packed = (JSON.parse(res.stdout)[0].files as { path: string }[]).map((f) => f.path);
    expect(packed).toContain("scripts/render-logo.mjs");
    expect(packed).toContain("assets/logo.png");
  }, 30_000); // budget, not a weaker assertion: npm pack is slow under full-suite load

  it("release staging carries them beside dist/cli, with a gate that refuses to publish without them", () => {
    const wf = readFileSync(join(PKG_ROOT, "..", ".github", "workflows", "release.yml"), "utf8");
    expect(wf).toContain("ix-cli/scripts/render-logo.mjs");
    expect(wf).toContain("ix-cli/assets/logo.png");
    expect(wf).toContain("banner inputs missing");
  });
});

describe("render-logo CLI contract", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, [RENDERER, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("exit 0 + JSON honesty block on --json (cells/ink/truncated)", () => {
    const meta = JSON.parse(run(["--width", "16", "--json"]));
    expect(meta.ok).toBe(true);
    expect(meta.tool).toBe("render-logo");
    expect(meta.truncated).toBe(false);
    expect(meta.cells.ink).toBeGreaterThan(0);
    expect(meta.cells.ink).toBeLessThan(meta.cells.total);
  });

  it("usage error exits 1 and reports to stderr, payload-free stdout", () => {
    let code = 0, stderrText = "", stdoutText = "";
    try {
      execFileSync(process.execPath, [RENDERER, "--width", "4"], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
      stderrText = e.stderr?.toString() ?? "";
      stdoutText = e.stdout?.toString() ?? "";
    }
    expect(code).toBe(1);
    expect(stderrText).toContain("--width");
    expect(stdoutText).toBe("");
  });

  it("library renderLogo() matches the CLI byte-for-byte (single algorithm)", () => {
    const viaCli = run(["--width", "24", "--color", "ascii"]);
    const viaLib = renderLogo({ width: 24, color: "ascii" });
    expect(viaLib).toBe(viaCli);
  }, 30_000); // budget, not a weaker assertion: the in-process render decodes the
  // full PNG (~16M byte-samples), and v8 coverage instrumentation inflates
  // that fixed cost ~10x (measured ~7s vs ~0.7s) on every coverage run; the
  // byte-identity assertion above stays exact.

  it("resolveColorMode honors NO_COLOR / COLORTERM / TERM", () => {
    expect(resolveColorMode("auto", { NO_COLOR: "1" } as NodeJS.ProcessEnv)).toBe("ascii");
    expect(resolveColorMode("auto", { COLORTERM: "truecolor", TERM: "xterm" } as NodeJS.ProcessEnv)).toBe("truecolor");
    expect(resolveColorMode("auto", { TERM: "xterm-256color" } as NodeJS.ProcessEnv)).toBe("256");
    expect(resolveColorMode("ascii")).toBe("ascii");
  });

  it("LogoError carries the toolscan-aligned exit code", () => {
    try {
      renderLogo({ width: 4 });
      expect.unreachable("width below minimum must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LogoError);
      expect((e as LogoError).code).toBe(1);
    }
  });

  it("--bg none paints only shape pixels: the backdrop never appears as a background", () => {
    // brand mode paints the navy canvas behind every partial cell; none mode
    // must never emit the backdrop constant as a background color.
    const brand = run(["--width", "20", "--color", "truecolor"]);
    const none = run(["--width", "20", "--color", "truecolor", "--bg", "none"]);
    expect(brand).toContain("48;2;5;10;30"); // brand paints the backdrop
    expect(none).not.toContain("48;2;5;10;30"); // none never does
    expect(none).toContain("▄"); // bottom-only cells emit the lower half-block
    expect(none).not.toBe(brand);
  });

  it("--bg none is byte-identical through the library and the CLI", () => {
    const viaCli = run(["--width", "24", "--color", "ascii", "--bg", "none"]);
    const viaLib = renderLogo({ width: 24, color: "ascii", bg: "none" });
    expect(viaLib).toBe(viaCli);
  }, 30_000); // budget, not a weaker assertion (see the sibling lib≡CLI pin)

  it("--bg none is reported honestly in the JSON block; default is brand", () => {
    expect(JSON.parse(run(["--width", "16", "--bg", "none", "--json"])).bg).toBe("none");
    expect(JSON.parse(run(["--width", "16", "--json"])).bg).toBe("brand");
  });

  it("--bg bogus exits 1 with the reason on stderr and a payload-free stdout", () => {
    let code = 0, stderrText = "", stdoutText = "";
    try {
      execFileSync(process.execPath, [RENDERER, "--width", "16", "--bg", "bogus"], { encoding: "utf8", stdio: "pipe" });
    } catch (e: any) {
      code = e.status;
      stderrText = e.stderr?.toString() ?? "";
      stdoutText = e.stdout?.toString() ?? "";
    }
    expect(code).toBe(1);
    expect(stderrText).toContain("--bg");
    expect(stdoutText).toBe("");
  });
});

describe("output stability (golden fixtures)", () => {
  // output-samples/*.ans are byte-pinned renders. Each filename encodes its
  // invocation (width-color[-bg-none]); the pin re-renders and compares, so
  // accidental visual drift fails CI. Update goldens ONLY in a dedicated,
  // stated commit that says what changed and why.
  // Goldens remain a repo-root artifact shared by the renderer's own docs.
  const GOLDENS_DIR = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "output-samples");
  const goldens = readdirSync(GOLDENS_DIR).filter((f) => f.endsWith(".ans"));

  it("ships goldens covering every color mode and both bg modes", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(6);
    expect(goldens.some((f) => f.includes("ascii"))).toBe(true);
    expect(goldens.some((f) => f.includes("256"))).toBe(true);
    expect(goldens.some((f) => f.endsWith("bg-none.ans"))).toBe(true);
  });

  for (const g of goldens) {
    it(`current render is byte-identical to the golden fixture: ${g}`, () => {
      const m = g.match(/^width-(\d+)-(truecolor|256|ascii)(-bg-none)?\.ans$/);
      expect(m, `fixture name must encode its invocation: ${g}`).not.toBeNull();
      const args = ["--width", m![1], "--color", m![2]];
      if (m![3]) args.push("--bg", "none");
      const expected = readFileSync(join(GOLDENS_DIR, g), "utf8");
      const actual = execFileSync(process.execPath, [RENDERER, ...args], { encoding: "utf8" });
      expect(actual).toBe(expected);
    });
  }
});
