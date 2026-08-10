import { describe, expect, it } from "vitest";
import { win32 as winPath } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { windowsShimBody } from "../commands/upgrade.js";
import { checkWindowsLauncher } from "../commands/doctor.js";

/**
 * Ix#385: `ix upgrade` before 0.9.0 refreshed only the bash shim and left
 * `%IX_HOME%\bin\ix.cmd` pointing at a `cli\ix.cmd` the upgrade had just
 * replaced with a version-nested directory. cmd.exe's error names the wrapper
 * rather than the cause:
 *
 *   '"C:\Users\Win 10\.ix\bin\..\cli\ix.cmd"' is not recognized as an internal
 *   or external command, operable program or batch file.
 *
 * The fix cannot be delivered by new CLI code — the *old* version performs the
 * upgrade — so the launcher has to diagnose itself, and the CLI that would
 * explain it is exactly as unreachable as the launcher.
 */
describe("windowsShimBody", () => {
  const FLAT = String.raw`%~dp0..\cli\ix.cmd`;
  const NESTED = String.raw`%~dp0..\cli\ix-0.9.1-windows-amd64\ix.cmd`;

  it("guards the target before invoking it", () => {
    const body = windowsShimBody(FLAT);
    const guard = body.indexOf(`if not exist "${FLAT}" goto :ix_missing`);
    const invoke = body.indexOf(`"${FLAT}" %*`);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(invoke).toBeGreaterThan(guard);
  });

  it("propagates the CLI's exit code on the success path", () => {
    // Without this the launcher always exits 0 and every non-zero ix exit —
    // a failed map, a Pro stub — reads as success to any caller.
    expect(windowsShimBody(FLAT)).toContain("exit /b %errorlevel%");
  });

  it("names the cause and the recovery, not just the missing path", () => {
    const body = windowsShimBody(FLAT);
    expect(body).toContain("ix upgrade");
    expect(body).toContain("irm https://ix-infra.com/install.ps1 ^| iex");
    expect(body).toContain("exit /b 1");
  });

  it("escapes the pipe so cmd.exe prints it instead of building a pipeline", () => {
    // A bare | in `echo irm ... | iex` pipes echo's output into `iex`, which
    // does not exist as a program on Windows, so the recovery line would be
    // replaced by an error about `iex`.
    const body = windowsShimBody(FLAT);
    expect(body).toContain("^| iex");
    expect(body).not.toMatch(/[^^]\| iex/);
  });

  it("uses CRLF, which batch files require", () => {
    const body = windowsShimBody(FLAT);
    expect(body).toContain("\r\n");
    expect(body.split("\r\n").length).toBeGreaterThan(5);
    expect(body).not.toMatch(/[^\r]\n/);
  });

  it("carries the nested target through verbatim", () => {
    const body = windowsShimBody(NESTED);
    expect(body).toContain(`if not exist "${NESTED}" goto :ix_missing`);
    expect(body).toContain(`"${NESTED}" %*`);
    expect(body).not.toContain(FLAT);
  });
});

describe("install.ps1 and refreshLaunchers emit the same launcher", () => {
  it("does not let the two writers drift apart", () => {
    // Two places write this file: install.ps1 on a fresh install, and
    // refreshLaunchers() on every upgrade. They have drifted before — the flat
    // vs version-nested shim bugs (#346, #385) were both one writer learning
    // something the other did not. A fresh install and an upgraded install must
    // end up with byte-identical launchers.
    const ps1 = readFileSync(
      fileURLToPath(new URL("../../../../scripts/install/install.ps1", import.meta.url)),
      "utf-8",
    );
    const heredoc = ps1.match(/@"\r?\n(@echo off\r?\n[\s\S]*?)\r?\n"@ \| Out-File/);
    expect(heredoc, "install.ps1 no longer contains the ix.cmd here-string").not.toBeNull();

    const fromInstaller = heredoc![1].replace(/\r?\n/g, "\n").trim();
    const fromUpgrade = windowsShimBody(String.raw`%~dp0..\cli\ix.cmd`)
      .replace(/\r?\n/g, "\n")
      .trim();

    expect(fromInstaller).toBe(fromUpgrade);
  });
});

describe("checkWindowsLauncher", () => {
  const IX_HOME = String.raw`C:\Users\Win 10\.ix`;
  const shim = (target: string) => windowsShimBody(target);

  it("passes when the launcher target exists", () => {
    const result = checkWindowsLauncher(
      IX_HOME,
      () => shim(String.raw`%~dp0..\cli\ix.cmd`),
      () => true,
    );
    expect(result.ok).toBe(true);
  });

  it("fails with the repair command when the target is gone", () => {
    const result = checkWindowsLauncher(
      IX_HOME,
      () => shim(String.raw`%~dp0..\cli\ix.cmd`),
      () => false,
    );
    expect(result.ok).toBe(false);
    expect(result.warn).toBeFalsy();
    expect(result.detail).toContain("does not exist");
    expect(result.detail).toContain("install.ps1");
  });

  it("resolves the target relative to bin/, matching %~dp0", () => {
    // %~dp0 is the directory of ix.cmd itself — IX_HOME\bin — so the check has
    // to resolve from there, not from IX_HOME, or it probes the wrong path and
    // reports a healthy install as broken.
    const probed: string[] = [];
    checkWindowsLauncher(
      IX_HOME,
      () => shim(String.raw`%~dp0..\cli\ix.cmd`),
      (p) => { probed.push(p); return true; },
    );
    expect(probed).toEqual([winPath.join(IX_HOME, "cli", "ix.cmd")]);
  });

  it("is silent when no launcher exists (POSIX install, or never installed)", () => {
    const result = checkWindowsLauncher(IX_HOME, () => null, () => false);
    expect(result.ok).toBe(true);
  });

  it("leaves an unrecognized launcher alone rather than calling it broken", () => {
    // A contributor's dev shim from scripts/dev/setup.sh points straight at a
    // working tree with an absolute path. Reporting that as a failure would
    // send them reinstalling over their own build.
    const result = checkWindowsLauncher(
      IX_HOME,
      () => '@echo off\r\nnode "C:\\src\\Ix\\ix-cli\\dist\\cli\\main.js" %*\r\n',
      () => false,
    );
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
  });
});
