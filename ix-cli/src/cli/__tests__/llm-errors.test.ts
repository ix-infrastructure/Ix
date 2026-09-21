// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliUsageError,
  detectRequestedFormat,
  renderCliError,
  setErrorFormat,
} from "../errors.js";

/** Node's fetch shape: `TypeError: fetch failed` with the real error nested. */
function unreachable(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:8090"),
    { code: "ECONNREFUSED" },
  );
  return err;
}

/**
 * Both streams, plus the exit. `renderCliError` reaches stderr two ways
 * (`process.stderr.write` and `console.error`) and stdout through
 * `console.log`; exit becomes a throw so an assertion can still run.
 */
function capture(fn: () => void): { out: string; err: string; exited: boolean } {
  let out = "";
  let err = "";
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out += args.map(String).join(" ") + "\n";
    }),
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      err += args.map(String).join(" ") + "\n";
    }),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    }),
  ];
  const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
    throw new Error("__exit__");
  }) as never);

  let exited = false;
  try {
    fn();
  } catch (error) {
    if ((error as Error).message !== "__exit__") throw error;
    exited = true;
  } finally {
    for (const spy of spies) spy.mockRestore();
    exit.mockRestore();
  }
  return { out, err, exited };
}

afterEach(() => setErrorFormat(undefined));

describe("detectRequestedFormat", () => {
  it("reads both spellings of the flag", () => {
    expect(detectRequestedFormat(["search", "foo", "--format", "llm"])).toBe("llm");
    expect(detectRequestedFormat(["search", "foo", "--format=llm"])).toBe("llm");
    expect(detectRequestedFormat(["status", "--format", "json"])).toBe("json");
  });

  it("is undefined when the caller did not ask", () => {
    expect(detectRequestedFormat(["status"])).toBeUndefined();
    expect(detectRequestedFormat([])).toBeUndefined();
  });

  it("stops at `--`, so a search term is never read as a flag", () => {
    expect(detectRequestedFormat(["text", "--", "--format", "llm"])).toBeUndefined();
  });

  it("does not read IX_FORMAT — that default is not in effect yet", () => {
    const original = process.env.IX_FORMAT;
    process.env.IX_FORMAT = "llm";
    try {
      expect(detectRequestedFormat(["status"])).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.IX_FORMAT;
      else process.env.IX_FORMAT = original;
    }
  });
});

describe("renderCliError with --format llm", () => {
  it("answers a dead backend on stdout, as one record, and exits non-zero", () => {
    setErrorFormat("llm");
    const { out, err, exited } = capture(() =>
      renderCliError(unreachable(), false, "http://localhost:8090"),
    );
    expect(out.trimEnd().split("\n")).toEqual([
      'error code=backend_unreachable message="Ix backend not reachable at http://localhost:8090." ' +
        'hint="Start it with `ix docker start`, then check `ix status`."',
    ]);
    expect(err).toBe("");
    expect(exited).toBe(true);
  });

  it("keeps the prose on stderr when no format was asked for", () => {
    const { out, err } = capture(() =>
      renderCliError(unreachable(), false, "http://localhost:8090"),
    );
    expect(out).toBe("");
    expect(err).toContain("Ix backend not reachable");
  });

  it("carries the backend's own code, message and next step", () => {
    setErrorFormat("llm");
    const { out } = capture(() =>
      renderCliError(
        new Error('404: {"error":"workspace_not_found","message":"No such workspace","next":"Run ix map"}'),
      ),
    );
    expect(out.trim()).toBe(
      'error code=workspace_not_found message="No such workspace" hint="Run ix map"',
    );
  });

  it("reports an unrecognised failure rather than guessing at a class for it", () => {
    setErrorFormat("llm");
    const { out } = capture(() => renderCliError(new Error("something odd")));
    expect(out.trim()).toBe('error code=cli_error message="something odd"');
  });

  it("gives a usage error its hint", () => {
    setErrorFormat("llm");
    const { out } = capture(() => renderCliError(new CliUsageError("Bad flag", "Try --kind class")));
    expect(out.trim()).toBe('error code=usage_error message="Bad flag" hint="Try --kind class"');
  });

  it("stays on one line however many the message had", () => {
    setErrorFormat("llm");
    const { out } = capture(() => renderCliError(new Error("line one\nline two")));
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).toContain("\\n");
  });
});
