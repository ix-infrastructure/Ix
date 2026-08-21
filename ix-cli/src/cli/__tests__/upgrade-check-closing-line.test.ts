import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closingStatus } from "../commands/upgrade.js";

/**
 * `ix upgrade --check` used to close with `[ok] ix is up to date` no matter what
 * it had just found, two lines under `New CLI version available: 0.10.0` (#476).
 *
 * The decision is tested twice over, and deliberately so. `closingStatus` covers
 * the rule; the command test below covers the wiring, because a branch that
 * forgets to record what it found leaves the rule correct and the output wrong —
 * which is the shape of the original bug.
 */
describe("closingStatus", () => {
  it("refuses to call an out-of-date install up to date under --check", () => {
    const status = closingStatus(true, ["CLI 0.9.2 → 0.10.0"]);
    expect(status.upToDate).toBe(false);
    expect(status).toHaveProperty("summary", "CLI 0.9.2 → 0.10.0");
  });

  it("lists every outstanding component, not just the first", () => {
    const status = closingStatus(true, ["CLI 0.9.2 → 0.10.0", "backend 1.0.16 → 1.0.17"]);
    // Reporting only the CLI would still be "not up to date" and still pass a
    // looser assertion, while hiding the two components the user must also pull.
    expect(status).toHaveProperty("summary", "CLI 0.9.2 → 0.10.0, backend 1.0.16 → 1.0.17");
  });

  it("says up to date under --check when nothing is outstanding", () => {
    expect(closingStatus(true, []).upToDate).toBe(true);
  });

  it("keeps the flat line on an install run, which has already acted", () => {
    // Not a shortcut: on this path every entry in the list has been installed by
    // the time the line prints, so reporting them as outstanding would describe
    // the work that just succeeded as still pending.
    expect(closingStatus(false, ["CLI 0.9.2 → 0.10.0"]).upToDate).toBe(true);
    expect(closingStatus(undefined, ["CLI 0.9.2 → 0.10.0"]).upToDate).toBe(true);
  });
});

describe("ix upgrade --check output", () => {
  let home: string;
  let logs: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ix-upgrade-check-"));
    process.env.IX_HOME = home;
    logs = [];
    // console, not process.stdout.write: vitest replaces the console object, so
    // patching the stream underneath it captures nothing and the assertion can
    // never fail.
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.IX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  async function runCheck(latestTag: string): Promise<string> {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ tag_name: latestTag }), { status: 200 }),
    );
    // Imported after IX_HOME is set: the module reads it at load time.
    const { Command } = await import("commander");
    const { registerUpgradeCommand } = await import("../commands/upgrade.js");
    const program = new Command();
    program.exitOverride();
    registerUpgradeCommand(program);
    await program.parseAsync(["node", "ix", "upgrade", "--check"]);
    return logs.join("\n");
  }

  it("does not claim to be up to date when it just announced a new version", async () => {
    const out = await runCheck("v99.0.0");
    expect(out).toContain("New CLI version available");
    expect(out).toContain("Run: ix upgrade");
    // The bug, stated as an assertion: these two cannot both be on screen.
    expect(out).not.toContain("ix is up to date");

    // Name the CLI *in the closing line*, not merely somewhere on screen. A
    // throwaway IX_HOME has no backend or compass stamp either, so both of those
    // are outstanding too and a bare `toContain("Update available")` passes even
    // when the CLI branch records nothing — the exact wiring this test exists to
    // hold. Matched by the fetched version rather than the current one, which
    // moves with every release bump.
    const closing = out.split("\n").find((l) => l.includes("Update available:"));
    expect(closing).toBeDefined();
    expect(closing).toMatch(/\bCLI\b/);
    expect(closing).toContain("99.0.0");
  });
});
