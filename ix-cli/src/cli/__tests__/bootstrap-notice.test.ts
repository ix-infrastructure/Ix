// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
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

// Every renderer subprocess this file needs, keyed by its invocation. Each one
// takes ~0.7s, almost all of it the PNG decode; run serially they were most of
// this file's wall time. beforeAll queues them all and the tests await the
// memoised result, so the assertions are unchanged.
//
// At most MAX_RENDERERS run at once: each decode peaks at ~400 MB RSS, and
// fifteen together (~4 GB on top of the other vitest workers) can push a 7 GB
// hosted runner into swap or OOM.
const MAX_RENDERERS = 4;
type CliResult = { status: number; stdout: string; stderr: string };
const cliRuns = new Map<string, Promise<CliResult>>();
let activeRenderers = 0;
let peakRenderers = 0;
const waiting: Array<() => void> = [];
async function withRendererSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeRenderers >= MAX_RENDERERS) await new Promise<void>((r) => waiting.push(r));
  activeRenderers++;
  peakRenderers = Math.max(peakRenderers, activeRenderers);
  try {
    return await work();
  } finally {
    activeRenderers--;
    waiting.shift()?.();
  }
}
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const key = JSON.stringify([args, env]);
  let p = cliRuns.get(key);
  if (!p) {
    p = withRendererSlot(
      () =>
        new Promise<CliResult>((resolve) => {
          execFile(
            process.execPath,
            [RENDERER, ...args],
            { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const code = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
              resolve({ status: typeof code === "number" ? code : -1, stdout, stderr });
            },
          );
        }),
    );
    cliRuns.set(key, p);
  }
  return p;
}
/** stdout of a render that must succeed (the old execFileSync contract). */
async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const res = await runCli(args, env);
  if (res.status !== 0) throw new Error(`render-logo ${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

// Goldens remain a repo-root artifact shared by the renderer's own docs.
const GOLDENS_DIR = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "output-samples");
const goldens = readdirSync(GOLDENS_DIR).filter((f) => f.endsWith(".ans"));
/** Each golden's filename encodes its invocation: width-color[-bg-none].ans. */
function goldenArgs(g: string): string[] | null {
  const m = g.match(/^width-(\d+)-(truecolor|256|ascii)(-bg-none)?\.ans$/);
  if (!m) return null;
  const args = ["--width", m[1], "--color", m[2]];
  if (m[3]) args.push("--bg", "none");
  return args;
}

// The banner, rendered ONCE for the whole file. Decoding the 5400x5440 logo
// costs ~0.7s in-process and 13-18s under v8 coverage, and this file used to
// pay it in five tests. renderBanner() caches its result, so the emitSetupNotice
// pins below reuse this render instead of decoding again.
let banner: string | null = null;

beforeAll(async () => {
  // Queue every subprocess render first, so the first MAX_RENDERERS run while
  // the in-process decode below holds this thread.
  const pending = Promise.all([
    ...goldens.map((g) => goldenArgs(g)).filter((a): a is string[] => a !== null).map((a) => runCli(a)),
    runCli(["--width", "16", "--json"]),
    runCli(["--width", "16", "--bg", "none", "--json"]),
    runCli(["--width", "20", "--color", "truecolor"]),
    runCli(["--width", "20", "--color", "truecolor", "--bg", "none"]),
    runCli(["--width", "24", "--color", "ascii", "--bg", "none"]),
    runCli(["--width", "48", "--color", "256"]),
    runCli(["--width", "16"], { NO_COLOR: "1" }),
    runCli(["--width", "4"]),
    runCli(["--width", "16", "--bg", "bogus"]),
  ]);

  // renderBanner() renders in-process with the inherited env; CI runners may
  // have TERM unset/dumb (resolving to the ASCII fallback, which has no
  // half-blocks). Pin the environment so the cached banner always exercises the
  // color path (256 colours at 48 columns, the same as the CLI's
  // `--width 48 --color 256`).
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("COLORTERM", "");
  vi.stubEnv("FORCE_COLOR", "");
  try {
    resetBannerCacheForTests();
    banner = renderBanner();
  } finally {
    vi.unstubAllEnvs();
  }

  // Every subprocess must be done before the absent-asset pin renames logo.png.
  await pending;
  // budget, not a weaker assertion: the default hookTimeout is 20s and the
  // in-process decode alone measured 18.1s under coverage instrumentation.
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
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
  });

  it("shows the logo banner when the renderer + asset are present", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    emitSetupNotice(true, false, "ws");

    expect(out).not.toHaveBeenCalled();
    // The banner rendered once in beforeAll; emitSetupNotice reads the same
    // cached render, so this is the logo itself, not the text fallback.
    expect(banner).not.toBeNull();
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderrText).toContain(banner!);
    expect(stderrText).not.toContain("Ix");
  });
});

describe("renderBanner", () => {
  it("returns a non-empty banner containing half-block cells", () => {
    // The banner rendered once in beforeAll, under a pinned color env (see
    // there); the assertions stay exact.
    expect(banner).not.toBeNull();
    expect(banner!.includes("▀")).toBe(true);
    // every non-empty line indented two spaces for the notice block
    // (a leading blank line is intentional spacing)
    for (const line of banner!.split("\n")) {
      if (line.trim()) expect(line.startsWith("  ")).toBe(true);
    }
  });

  it("renders ASCII under NO_COLOR and never writes stdout", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const raw = await run(["--width", "16"], { NO_COLOR: "1" });
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
  it("never runs more than four renderer subprocesses at once (bounded memory)", () => {
    // beforeAll queued every render this file needs; the cap must have held.
    expect(cliRuns.size).toBeGreaterThan(MAX_RENDERERS);
    expect(peakRenderers).toBeGreaterThan(0);
    expect(peakRenderers).toBeLessThanOrEqual(4);
  });

  it("exit 0 + JSON honesty block on --json (cells/ink/truncated)", async () => {
    const meta = JSON.parse(await run(["--width", "16", "--json"]));
    expect(meta.ok).toBe(true);
    expect(meta.tool).toBe("render-logo");
    expect(meta.truncated).toBe(false);
    expect(meta.cells.ink).toBeGreaterThan(0);
    expect(meta.cells.ink).toBeLessThan(meta.cells.total);
  });

  it("usage error exits 1 and reports to stderr, payload-free stdout", async () => {
    const { status: code, stderr: stderrText, stdout: stdoutText } = await runCli(["--width", "4"]);
    expect(code).toBe(1);
    expect(stderrText).toContain("--width");
    expect(stdoutText).toBe("");
  });

  it("library renderLogo() matches the CLI byte-for-byte (single algorithm)", async () => {
    // The in-process side is the banner rendered once in beforeAll:
    // renderLogo({ width: 48, color: "auto" }) under TERM=xterm-256color, i.e.
    // 256 colours. Put the CLI's output through the same indent banner.ts
    // applies; any difference in cells or colour codes fails here.
    const viaCli = await run(["--width", "48", "--color", "256"]);
    const indented = viaCli
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l.trim() ? `  ${l}` : l))
      .join("\n");
    expect(banner).toBe(indented);
  });

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

  it("--bg none paints only shape pixels: the backdrop never appears as a background", async () => {
    // brand mode paints the logo's own (modal) backdrop color behind every
    // partial cell; none mode must never emit that constant as a background.
    // The sharp renderer detects the backdrop from the asset itself instead of
    // hardcoding one, so the constant here is the Ix PNG's modal color.
    const brand = await run(["--width", "20", "--color", "truecolor"]);
    const none = await run(["--width", "20", "--color", "truecolor", "--bg", "none"]);
    expect(brand).toContain("48;2;0;0;27"); // brand paints the asset's backdrop
    expect(none).not.toContain("48;2;0;0;27"); // none never does
    expect(none).toContain("▄"); // bottom-only cells emit the lower half-block
    expect(none).not.toBe(brand);
  });

  it("--bg none is byte-identical through the library and the CLI", async () => {
    // The file's one direct in-process renderLogo() decode (the banner in
    // beforeAll is the other).
    const viaCli = await run(["--width", "24", "--color", "ascii", "--bg", "none"]);
    const viaLib = renderLogo({ width: 24, color: "ascii", bg: "none" });
    expect(viaLib).toBe(viaCli);
  }, 30_000); // budget, not a weaker assertion: the in-process render decodes the
  // full PNG (~16M byte-samples), and v8 coverage instrumentation inflates
  // that fixed cost ~10x (measured 13-18s vs ~0.7s) on every coverage run; the
  // byte-identity assertion above stays exact.

  it("--bg none is reported honestly in the JSON block; default is brand", async () => {
    expect(JSON.parse(await run(["--width", "16", "--bg", "none", "--json"])).bg).toBe("none");
    expect(JSON.parse(await run(["--width", "16", "--json"])).bg).toBe("brand");
  });

  it("--bg bogus exits 1 with the reason on stderr and a payload-free stdout", async () => {
    const { status: code, stderr: stderrText, stdout: stdoutText } = await runCli(["--width", "16", "--bg", "bogus"]);
    expect(code).toBe(1);
    expect(stderrText).toContain("--bg");
    expect(stdoutText).toBe("");
  });
});

describe("output stability (golden fixtures)", () => {
  // output-samples/*.ans are byte-pinned renders. Each filename encodes its
  // invocation (width-color[-bg-none]); the pin re-renders and compares, so
  // accidental visual drift fails CI. Update goldens ONLY in a dedicated,
  // stated commit that says what changed and why. (GOLDENS_DIR, goldens and
  // goldenArgs live at the top of the file, so beforeAll can start the renders.)

  it("ships goldens covering every color mode and both bg modes", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(6);
    expect(goldens.some((f) => f.includes("ascii"))).toBe(true);
    expect(goldens.some((f) => f.includes("256"))).toBe(true);
    expect(goldens.some((f) => f.endsWith("bg-none.ans"))).toBe(true);
  });

  for (const g of goldens) {
    it(`current render is byte-identical to the golden fixture: ${g}`, async () => {
      const args = goldenArgs(g);
      expect(args, `fixture name must encode its invocation: ${g}`).not.toBeNull();
      const expected = readFileSync(join(GOLDENS_DIR, g), "utf8");
      const actual = await run(args!);
      expect(actual).toBe(expected);
    });
  }
});

// Last in the file: this pin renames the real assets/logo.png and clears the
// banner cache. A later renderBanner() call would only re-render (slower,
// never wrong), but keeping it last means nothing after it pays that.
describe("emitSetupNotice without the asset", () => {
  it("falls back to the plain text heading when the asset is absent (absent-safe)", () => {
    // A layout without the packaged asset must degrade to the old heading —
    // never throw, never leave the notice block empty. The renderer reads the
    // asset at call time, so renaming it exercises exactly that layout.
    // Within-file tests run sequentially and beforeAll awaited every
    // subprocess render, so the temporary rename is invisible to the other
    // pins. The banner cache is cleared on both sides of the rename: before,
    // so this render actually reads the (missing) asset; after, so the
    // fallback is not left cached.
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const assetBackup = LOGO_ASSET + ".bak";
    resetBannerCacheForTests();
    renameSync(LOGO_ASSET, assetBackup);
    try {
      emitSetupNotice(true, false, "ws");
      const stderrText = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(stderrText).toContain("Ix");
      expect(stderrText).not.toContain("▀");
    } finally {
      renameSync(assetBackup, LOGO_ASSET);
      resetBannerCacheForTests();
    }
    expect(out).not.toHaveBeenCalled();
  });
});
