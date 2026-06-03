import { describe, it, expect, vi, afterEach } from "vitest";
import { emitSetupNotice } from "../bootstrap.js";

afterEach(() => vi.restoreAllMocks());

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

  it("emits nothing when neither config nor workspace was newly created", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    emitSetupNotice(false, false, "x");

    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
