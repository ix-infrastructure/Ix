import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("surfaces stderr from a command that ran and failed, exactly once", () => {
    // A real tar failure explains itself on stderr — but execFileSync has
    // already folded that stderr into `message` by the time it throws, so
    // returning `${message}: ${stderr}` printed the whole complaint twice.
    //
    // Asserting only that the archive name appears is not enough: it appears in
    // the `Command failed: tar -xzf <path>` prefix regardless, so that
    // assertion passes even with `.stderr` stripped off the error entirely and
    // proves nothing about stderr being read back.
    let err: unknown;
    try {
      execFileSync("tar", ["-xzf", "/nonexistent/definitely-missing.tar.gz"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      err = e;
    }
    const e = err as Error & { stderr?: Buffer };
    const captured = e.stderr?.toString().trim() ?? "";
    // The pipe really did capture something, and Node really did fold it in.
    expect(captured).not.toBe("");
    expect(e.message).toContain(captured);

    const msg = describeExecFailure(err);
    expect(msg).toBe(e.message);
    // tar's wording varies by implementation, so count rather than match: every
    // line stderr produced appears once, not twice.
    for (const line of captured.split("\n").filter((l) => l.trim())) {
      expect(msg.split(line).length - 1).toBe(1);
    }
  });

  it("appends stderr when the message does not already carry it", () => {
    // The other half of the same branch: a caller that captured stderr without
    // Node folding it in still gets it, rather than a bare "Command failed".
    const bare = Object.assign(new Error("Command failed: tar -xzf compass.tar.gz"), {
      stderr: Buffer.from("tar: could not chdir to the destination\n"),
    });
    expect(describeExecFailure(bare)).toBe(
      "Command failed: tar -xzf compass.tar.gz: tar: could not chdir to the destination"
    );
  });

  it("does not blame PATH for a filesystem ENOENT", () => {
    // fs errors carry code ENOENT too, and the compass block runs writeFileSync
    // and mkdirSync inside the same try. "ENOENT: no such file or directory,
    // open '...\\.version' — is it installed and on PATH?" is advice about a
    // file, and there is nothing the user can do with it. Only a spawn failure
    // is a PATH problem, which is what the syscall distinguishes.
    let err: unknown;
    try {
      writeFileSync(join(tmpdir(), "ix-no-such-dir-here", "nested", ".version"), "1.0.0");
    } catch (e) {
      err = e;
    }
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(describeExecFailure(err)).not.toContain("PATH");
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
