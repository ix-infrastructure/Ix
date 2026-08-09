import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { describeExecFailure } from "../commands/upgrade.js";

describe("describeExecFailure", () => {
  it("names PATH as the fix when the binary does not exist", () => {
    // The Windows compass repair failed with nothing on screen. If the cause
    // was a missing tar, the message has to say so — "spawnSync tar ENOENT"
    // alone does not tell you what to do about it.
    // Assembled at runtime so knip does not read it as a real binary this
    // package depends on and fail the dead-code check on an unlisted one.
    const missing = ["ix", "no", "such", "binary"].join("-");
    let err: unknown;
    try {
      execFileSync(missing, ["--version"], { stdio: "ignore" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = describeExecFailure(err);
    expect(msg).toContain(missing);
    expect(msg).toContain("PATH");
  });

  it("surfaces stderr from a command that ran and failed", () => {
    // A real tar failure explains itself on stderr. Piping it is only useful if
    // it is read back out of the error, which is what this covers.
    let err: unknown;
    try {
      execFileSync("tar", ["-xzf", "/nonexistent/definitely-missing.tar.gz"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = describeExecFailure(err);
    // tar's wording varies by implementation; what matters is that the archive
    // it could not open is named, rather than the message being swallowed.
    expect(msg.toLowerCase()).toContain("definitely-missing.tar.gz");
  });

  it("does not throw on a non-Error rejection", () => {
    expect(describeExecFailure("plain string")).toBe("plain string");
    expect(describeExecFailure(undefined)).toBe("undefined");
  });

  it("falls back to the message when nothing was captured on stderr", () => {
    const bare = new Error("spawnSync tar EACCES");
    expect(describeExecFailure(bare)).toBe("spawnSync tar EACCES");
  });
});
