// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteResolutionNotices, printJson, resetResolutionNotices } from "../format.js";
import { runPerTarget } from "../multi-target.js";

// Resolution notices are module state (format.ts). A target that queues one and
// then throws never reaches the printJson that would take it, so runPerTarget
// must not let it ride into the next target's answer, or onto the grouping.

const NOTICE = { code: "ambiguous_target", target: "first", message: "first matches 2 candidates equally" };

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  resetResolutionNotices();
});
afterEach(() => {
  process.exitCode = savedExitCode;
  resetResolutionNotices();
});

describe("runPerTarget and pending resolution notices", () => {
  it("drops a thrown target's notices instead of handing them to the next target (json)", async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
    try {
      await runPerTarget(["first", "second", "third"], "json", async (target) => {
        if (target === "second") {
          printJson({ resolvedTarget: { name: target } });
          return;
        }
        noteResolutionNotices([{ ...NOTICE, target }]);
        throw new Error(`backend failed for ${target}`);
      });
    } finally {
      log.mockRestore();
    }
    const body = JSON.parse(out.join("\n"));
    expect(body.targets.map((t: { target: string }) => t.target)).toEqual(["first", "second", "third"]);
    expect(body.targets[0].error).toBe("cli_error");
    expect(body.targets[1].resolvedTarget).toEqual({ name: "second" });
    expect(body.targets[1].resolutionNotices).toBeUndefined();
    expect(body.resolutionNotices).toBeUndefined();
  });

  it("keeps a target's own notices", async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
    try {
      await runPerTarget(["first", "second"], "json", async (target) => {
        noteResolutionNotices([{ ...NOTICE, target }]);
        printJson({ resolvedTarget: { name: target } });
      });
    } finally {
      log.mockRestore();
    }
    const body = JSON.parse(out.join("\n"));
    expect(body.targets.map((t: { resolutionNotices: Array<{ target: string }> }) => t.resolutionNotices.map((n) => n.target)))
      .toEqual([["first"], ["second"]]);
  });
});
