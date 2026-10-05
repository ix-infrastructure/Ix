// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** A release archive that does not match its published checksum, or has none. */
export class ChecksumError extends Error {
  override name = "ChecksumError";
}

/**
 * The digest from a `<asset>.sha256` sidecar: `sha256sum` output, one line of
 * `<64 hex>  <file name>` (the name may carry a leading `*` in binary mode).
 * When the line names a file it must be `expectedName`, so a sidecar for a
 * different asset cannot vouch for this one.
 */
export function parseSha256Sidecar(text: string, expectedName: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+?))?\s*$/.exec(line.trim());
  if (!match) throw new ChecksumError(`checksum file for ${expectedName} is not in sha256sum format`);
  const named = match[2];
  if (named !== undefined && basename(named) !== expectedName) {
    throw new ChecksumError(`checksum file names ${named}, not ${expectedName}`);
  }
  return match[1].toLowerCase();
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Throws ChecksumError unless `file` hashes to `expectedHex`. */
export function verifySha256(file: string, expectedHex: string): void {
  const actual = Buffer.from(sha256File(file), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new ChecksumError(
      `checksum mismatch for ${basename(file)}: expected ${expectedHex}, got ${actual.toString("hex")}`,
    );
  }
}

/**
 * Downloads `url` to `dest` and checks it against `url + ".sha256"` before
 * anything reads it. Fails closed: a missing or unreadable checksum is an
 * error, not a skip. Both requests go through curl, like the rest of
 * `ix upgrade`, so proxies and certificates behave the same for each.
 *
 * Throws ChecksumError for a bad or missing checksum; any other error is the
 * download itself failing.
 */
export function downloadVerified(
  url: string,
  dest: string,
  opts: { timeoutMs: number; progress?: boolean },
): void {
  execFileSync("curl", ["-fsSL", ...(opts.progress ? ["--progress-bar"] : []), url, "-o", dest], {
    stdio: ["ignore", "inherit", "inherit"],
    timeout: opts.timeoutMs,
  });
  let sidecar: string;
  try {
    sidecar = execFileSync("curl", ["-fsSL", `${url}.sha256`], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      encoding: "utf8",
    });
  } catch {
    throw new ChecksumError(`no published checksum at ${url}.sha256; refusing to install an unverified archive`);
  }
  verifySha256(dest, parseSha256Sidecar(sidecar, basename(new URL(url).pathname)));
}

/**
 * Build provenance for a CLI release archive, checked with the GitHub CLI when
 * it is installed: `gh attestation verify` against the release workflow. The
 * checksum is the gate; this is a second, independent check whose failure is
 * reported but does not block, because it also fails for reasons that say
 * nothing about the archive (gh not logged in, no network to the API).
 */
export function attestationCommand(file: string, repo: string): [string, string[]] {
  return [
    "gh",
    ["attestation", "verify", file, "-R", repo, "--signer-workflow", `${repo}/.github/workflows/release.yml`],
  ];
}

/** `unavailable`: no gh on PATH, or one too old to have `gh attestation`. */
export type AttestationResult = { status: "verified" } | { status: "failed"; detail: string } | { status: "unavailable" };

export function verifyAttestation(file: string, repo: string): AttestationResult {
  const [cmd, args] = attestationCommand(file, repo);
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return { status: "verified" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const detail = String(e.stderr || e.message).trim();
    if (e.code === "ENOENT" || /unknown command "attestation"/.test(detail)) return { status: "unavailable" };
    return { status: "failed", detail: detail.split("\n")[0] ?? "" };
  }
}
