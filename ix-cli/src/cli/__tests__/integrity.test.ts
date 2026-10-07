// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ChecksumError,
  attestationCommand,
  downloadVerified,
  parseSha256Sidecar,
  verifySha256,
} from "../integrity.js";

const ARCHIVE = Buffer.from("pretend this is ix-9.9.9-linux-amd64.tar.gz\n".repeat(200));
const NAME = "ix-9.9.9-linux-amd64.tar.gz";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * A release host serving `www/` from a separate process: downloadVerified runs
 * curl synchronously, which would block a server living in this event loop.
 */
let host: ChildProcess;
let base = "";
let dir = "";
let www = "";

const HOST_SCRIPT = `
const http = require("http"), fs = require("fs"), path = require("path");
const root = process.argv[1];
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(file, (err, body) => { if (err) { res.writeHead(404).end(); } else { res.writeHead(200).end(body); } });
}).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port) + "\\n"); });
`;

/** Replace what the host serves: URL path -> body. */
function serve(files: Record<string, Buffer | string>): void {
  rmSync(www, { recursive: true, force: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(www, dirname(path)), { recursive: true });
    writeFileSync(join(www, path), body);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ix-integrity-"));
  www = join(dir, "www");
  host = spawn(process.execPath, ["-e", HOST_SCRIPT, www], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    host.once("error", reject);
    host.stdout!.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  host.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadVerified", () => {
  it("accepts an archive that matches its published checksum", () => {
    serve({ [`/v9.9.9/${NAME}`]: ARCHIVE, [`/v9.9.9/${NAME}.sha256`]: `${sha(ARCHIVE)}  ${NAME}\n` });
    const dest = join(dir, "good.tar.gz");
    downloadVerified(`${base}/v9.9.9/${NAME}`, dest, { timeoutMs: 10_000 });
    expect(readFileSync(dest).equals(ARCHIVE)).toBe(true);
  });

  it("refuses an archive with one byte flipped", () => {
    const tampered = Buffer.from(ARCHIVE);
    tampered[100] ^= 0x01;
    serve({ [`/v9.9.9/${NAME}`]: tampered, [`/v9.9.9/${NAME}.sha256`]: `${sha(ARCHIVE)}  ${NAME}\n` });
    expect(() => downloadVerified(`${base}/v9.9.9/${NAME}`, join(dir, "bad.tar.gz"), { timeoutMs: 10_000 })).toThrow(
      /checksum mismatch/,
    );
  });

  it("fails closed when the release publishes no checksum", () => {
    serve({ [`/v9.9.9/${NAME}`]: ARCHIVE });
    let err: unknown;
    try {
      downloadVerified(`${base}/v9.9.9/${NAME}`, join(dir, "nosum.tar.gz"), { timeoutMs: 10_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChecksumError);
    expect(String(err)).toMatch(/no published checksum/);
  });

  it("refuses a checksum file that vouches for a different asset", () => {
    serve({
      [`/v9.9.9/${NAME}`]: ARCHIVE,
      [`/v9.9.9/${NAME}.sha256`]: `${sha(ARCHIVE)}  ix-9.9.9-darwin-arm64.tar.gz\n`,
    });
    expect(() => downloadVerified(`${base}/v9.9.9/${NAME}`, join(dir, "other.tar.gz"), { timeoutMs: 10_000 })).toThrow(
      ChecksumError,
    );
  });

  it("reports a failed archive download as a download error, not a checksum error", () => {
    serve({});
    const dest = join(dir, "missing.tar.gz");
    let err: unknown;
    try {
      downloadVerified(`${base}/v9.9.9/${NAME}`, dest, { timeoutMs: 10_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ChecksumError);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("parseSha256Sidecar", () => {
  const hex = "a".repeat(64);

  it("reads sha256sum output in text and binary mode, with or without a name", () => {
    expect(parseSha256Sidecar(`${hex}  ${NAME}\n`, NAME)).toBe(hex);
    expect(parseSha256Sidecar(`${hex} *${NAME}\r\n`, NAME)).toBe(hex);
    expect(parseSha256Sidecar(`${hex.toUpperCase()}\n`, NAME)).toBe(hex);
  });

  it("rejects anything that is not a sha256 digest", () => {
    expect(() => parseSha256Sidecar("<html>Not Found</html>", NAME)).toThrow(ChecksumError);
    expect(() => parseSha256Sidecar(`${"a".repeat(63)}  ${NAME}`, NAME)).toThrow(ChecksumError);
    expect(() => parseSha256Sidecar("", NAME)).toThrow(ChecksumError);
  });
});

describe("verifySha256", () => {
  it("names the expected and actual digests on a mismatch", () => {
    serve({});
    const dest = join(dir, "local.bin");
    writeFileSync(dest, ARCHIVE);
    expect(() => verifySha256(dest, sha(ARCHIVE))).not.toThrow();
    expect(() => verifySha256(dest, "b".repeat(64))).toThrow(new RegExp(`expected ${"b".repeat(64)}, got ${sha(ARCHIVE)}`));
  });
});

describe("attestationCommand", () => {
  it("verifies against this repository's release workflow", () => {
    expect(attestationCommand("ix.tar.gz", "ix-infrastructure/Ix")).toEqual([
      "gh",
      [
        "attestation",
        "verify",
        "ix.tar.gz",
        "-R",
        "ix-infrastructure/Ix",
        "--signer-workflow",
        "ix-infrastructure/Ix/.github/workflows/release.yml",
      ],
    ]);
  });
});
