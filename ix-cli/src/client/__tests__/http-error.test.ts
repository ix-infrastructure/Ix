// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { httpError, LocalTokenRequiredError } from "../api.js";
import { httpStatusOf, isIxHttpError, IxHttpError } from "../http-error.js";
import { isPreConnectionFailure } from "../transport.js";
import { isBackendUnreachable } from "../../cli/errors.js";

// `httpError`'s message is part of what the CLI prints and of what external
// code may read, so it keeps its `<status>: <body>` shape exactly. Callers in
// this repo read the status, code and body off the typed error instead (#940).
describe("httpError", () => {
  const body = '{"error":"service unavailable"}';

  it("keeps the message byte-identical and carries status and Retry-After when given headers", () => {
    const err = httpError(503, body, new Headers({ "Retry-After": "2" }));
    expect(err.message).toBe(`503: ${body}`);
    expect(err.message).toBe(httpError(503, body).message);
    expect(err).toBeInstanceOf(IxHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("Error");
    expect(String(err)).toBe(`Error: 503: ${body}`);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe("2");
    expect(err.body).toBe(body);
    // Non-enumerable: nothing that serialises or spreads an error picks them up.
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify(err)).toBe("{}");
  });

  it("has no Retry-After when the response had none", () => {
    const err = httpError(502, "bad gateway", new Headers());
    expect(err.status).toBe(502);
    expect(err.retryAfter).toBeUndefined();
    expect("retryAfter" in err).toBe(false);
  });

  it("carries the status and body without headers too", () => {
    const err = httpError(503, body);
    expect(err.message).toBe(`503: ${body}`);
    expect(err.status).toBe(503);
    expect(err.body).toBe(body);
    expect("retryAfter" in err).toBe(false);
  });

  it("parses `code` out of a JSON body, and only a string one", () => {
    expect(httpError(409, '{"code":"conflict","message":"m"}').code).toBe("conflict");
    expect(httpError(409, '{"code":7}').code).toBeUndefined();
    expect(httpError(409, '{"error":"conflict"}').code).toBeUndefined();
    expect(httpError(502, "<html>502: Bad Gateway</html>").code).toBeUndefined();
    expect(httpError(502, "[1,2]").code).toBeUndefined();
  });

  it("keeps `body` to what the message holds: a long non-JSON page is cut", () => {
    const page = `<html>${"x".repeat(1000)}</html>`;
    const err = httpError(504, page);
    expect(err.body.length).toBeLessThan(page.length);
    expect(err.message).toBe(`504: ${err.body}`);
  });

  it("still raises LocalTokenRequiredError for the loopback guard's 401, as an IxHttpError", () => {
    const guard = '{"code":"local_token_required","error":"token required"}';
    const err = httpError(401, guard, new Headers({ "Retry-After": "1" }));
    expect(err).toBeInstanceOf(LocalTokenRequiredError);
    expect(err).toBeInstanceOf(IxHttpError);
    expect(err.message).toBe(`401: ${guard}`);
    expect(err.name).toBe("LocalTokenRequiredError");
    expect(err.status).toBe(401);
    expect(err.code).toBe("local_token_required");
    expect("retryAfter" in err).toBe(false);
  });
});

describe("httpStatusOf", () => {
  it("reads the status off an IxHttpError and nothing else", () => {
    expect(httpStatusOf(httpError(404, "nope"))).toBe(404);
    // A message in the old shape is not a status: anything can prefix or forge it.
    expect(httpStatusOf(new Error("404: nope"))).toBeUndefined();
    expect(httpStatusOf(Object.assign(new Error("x"), { status: 404 }))).toBeUndefined();
    expect(httpStatusOf("404: nope")).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
  });
});

describe("isIxHttpError", () => {
  it("recognises one from another copy of the module, where instanceof cannot", async () => {
    vi.resetModules();
    const other = await import("../http-error.js");
    expect(other.IxHttpError).not.toBe(IxHttpError);
    const err = new other.IxHttpError(503, "busy");
    expect(err instanceof IxHttpError).toBe(false);
    expect(isIxHttpError(err)).toBe(true);
    expect(httpStatusOf(err)).toBe(503);
    expect(other.httpStatusOf(httpError(404, "x"))).toBe(404);
  });

  it("is false for anything else", () => {
    for (const v of [new Error("503: busy"), "503: busy", null, undefined, 503, { status: 503, body: "" }]) {
      expect(isIxHttpError(v)).toBe(false);
    }
  });
});

describe("a body's code is the server's, not a socket's", () => {
  // A proxy in front of a dead upstream may answer with `{"code":"ECONNREFUSED"}`.
  // That request reached a server, so it is neither "never connected" (which
  // `reset` reads as "nothing was deleted") nor "backend unreachable".
  it("is not read as a transport failure", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_SOCKET"]) {
      const err = httpError(502, JSON.stringify({ code, message: "upstream down" }));
      expect(err.code).toBe(code);
      expect(isPreConnectionFailure(err), code).toBe(false);
      expect(isBackendUnreachable(err), code).toBe(false);
    }
    // The real transport failure is still one.
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    expect(isPreConnectionFailure(refused)).toBe(true);
    expect(isBackendUnreachable(refused)).toBe(true);
  });
});

// #940: the status of a failed request is a typed field. A regex that reads a
// status code back out of an error's message (or `String(err)`) is how the
// same failure came to be classified differently in two places, so none may
// come back outside tests.
describe("no status regexes over error messages", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__") out.push(...sourceFiles(path));
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(path);
      }
    }
    return out;
  }

  // An anchored status prefix in a regex (`/^404:/`, `/^(\d{3}):/`,
  // `/^(?:Error:\s*)?(502|503):/`, `/(^|\s)409: \{/`), or a
  // `startsWith("404:")`.
  const STATUS_IN_REGEX =
    /(?:\^|\(\^\|\\s\))(?:\(\?:[Ee]rror:\\s\*\)\?)?(?:\((?:\?:)?)?(?:\\d\{3\}|\\d\+|[1-5]\d\d(?:\|[1-5]\d\d)*)\)?(?::|\(\?:\\b\|:\))/;
  const STATUS_STARTS_WITH = /startsWith\(\s*["'`][1-5]\d\d:/;

  it("finds none in src/", () => {
    const offenders: string[] = [];
    const allowed: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*(\/\/|\*).*$/, "");
        if (!STATUS_IN_REGEX.test(code) && !STATUS_STARTS_WITH.test(code)) return;
        const where = `${relative(srcRoot, file)}:${i + 1}: ${line.trim()}`;
        (lines[i - 1]?.includes("ix-940-allow:") ? allowed : offenders).push(where);
      });
    }
    expect(offenders).toEqual([]);
    // The one exception: `parseBackendError` recovering a JSON body (not a
    // status) from a message for an error `httpError` did not build.
    expect(allowed.map((w) => w.split(":")[0])).toEqual(["cli/errors.ts"]);
  });

  it("would catch the shapes #940 removed", () => {
    for (const line of [
      String.raw`const RETRYABLE_READ_STATUS = /^(502|503|504):/;`,
      String.raw`if (err instanceof Error && err.message.startsWith("404:")) return x;`,
      String.raw`const m = /^(\d{3}):/.exec(message);`,
      String.raw`const m = /^503:\s*(\{.*\})\s*$/s.exec(message);`,
      String.raw`const match = /^\d+: (.+)$/.exec(err.message ?? "");`,
      String.raw`return /^(?:Error:\s*)?(?:404|405|501):/.test(String(error));`,
      String.raw`if (/^(?:error:\s*)?413(?:\b|:)/.test(message)) return true;`,
      String.raw`return /(^|\s)409: \{/.test(String(err));`,
    ]) {
      expect(STATUS_IN_REGEX.test(line) || STATUS_STARTS_WITH.test(line), line).toBe(true);
    }
  });
});
