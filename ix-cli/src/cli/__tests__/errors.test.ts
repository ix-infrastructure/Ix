import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliResolutionError,
  CliUsageError,
  formatFetchError,
  isBackendUnreachable,
  renderCliError,
} from "../errors.js";

/** Node's fetch shape: `TypeError: fetch failed` with the real error nested. */
function fetchFailure(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(
    new Error(`connect ${code} 127.0.0.1:8090`),
    { code, errno: -111, syscall: "connect" },
  );
  return err;
}

/**
 * The same shape for a socket that was established and then died.
 *
 * The classifier keys on the code alone, so as an input this differs from
 * `fetchFailure` only in fields nothing reads. It is here to name the scenario
 * the mid-flight codes stand for — it is not a phase discriminator, and a code
 * moved into UNREACHABLE_CODES would not be caught by using this helper.
 */
function midFlightFailure(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(
    new Error(`read ${code} 127.0.0.1:8090`),
    { code, errno: -104, syscall: "read" },
  );
  return err;
}

/**
 * renderCliError writes to stderr and then exits. It reaches stderr two ways —
 * process.stderr.write directly, and console.error via renderStructuredError —
 * so both are captured here. Exit is turned into a throw so asserting on the
 * rendered output does not kill the test runner.
 */
function capture(fn: () => void): { out: string; exited: boolean } {
  let out = "";
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const log = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      out += args.map(String).join(" ") + "\n";
    });
  const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
    throw new Error("__exit__");
  }) as never);

  let exited = false;
  try {
    fn();
  } catch (err) {
    if ((err as Error).message === "__exit__") exited = true;
    else throw err;
  } finally {
    write.mockRestore();
    log.mockRestore();
    exit.mockRestore();
  }
  return { out, exited };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isBackendUnreachable", () => {
  it("detects a transport code nested under cause (Node fetch shape)", () => {
    expect(isBackendUnreachable(fetchFailure("ECONNREFUSED"))).toBe(true);
    expect(isBackendUnreachable(fetchFailure("EHOSTUNREACH"))).toBe(true);
    expect(isBackendUnreachable(fetchFailure("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
  });

  it("detects a transport code set directly on the error", () => {
    expect(isBackendUnreachable(Object.assign(new Error("nope"), { code: "ECONNREFUSED" }))).toBe(true);
  });

  it("does not claim unreachability for backend-authored errors", () => {
    // The backend answered — it just answered with an error. That must keep
    // rendering the real message rather than "start the backend".
    expect(isBackendUnreachable(new Error('500: {"error":"boom","message":"kaput"}'))).toBe(false);
    expect(isBackendUnreachable(new Error("something else"))).toBe(false);
  });

  it("tolerates null, undefined and non-error values", () => {
    expect(isBackendUnreachable(null)).toBe(false);
    expect(isBackendUnreachable(undefined)).toBe(false);
    expect(isBackendUnreachable("a string")).toBe(false);
  });

  it("does not claim unreachability for a connection dropped mid-flight", () => {
    // A connection that was working and then died is a different problem with a
    // different remedy; "start the backend" is the wrong thing to say about it.
    expect(isBackendUnreachable(midFlightFailure("ECONNRESET"))).toBe(false);
    expect(isBackendUnreachable(midFlightFailure("ETIMEDOUT"))).toBe(false);
  });

  it("claims unreachability when the port accepts but nothing serves", () => {
    // Measured shape of a container that is still booting, or a published port
    // with a dead container behind it: undici accepts, gets a FIN, and reports
    // "other side closed". That user does need `ix docker start` / `ix status`.
    expect(isBackendUnreachable(fetchFailure("UND_ERR_SOCKET"))).toBe(true);
  });
});

describe("renderCliError", () => {
  it("renders backend-down as actionable guidance, never a stack trace", () => {
    const { out, exited } = capture(() =>
      renderCliError(fetchFailure("ECONNREFUSED"), false, "http://localhost:8090"),
    );

    expect(exited).toBe(true);
    expect(out).toContain("Ix backend not reachable at http://localhost:8090");
    expect(out).toContain("ix docker start");
    // The whole point of the boundary: no Node internals, no absolute paths.
    expect(out).not.toContain("node:internal");
    expect(out).not.toContain("at async");
  });

  it("omits the endpoint when it cannot be resolved", () => {
    const { out } = capture(() => renderCliError(fetchFailure("ECONNREFUSED"), false, undefined));
    expect(out).toContain("Ix backend not reachable.");
  });

  it("unwraps a bare `fetch failed` so the transport cause is visible", () => {
    const { out } = capture(() =>
      renderCliError(Object.assign(new TypeError("fetch failed"), { cause: { message: "socket hang up" } })),
    );
    expect(out).toContain("socket hang up");
  });

  it("renders a structured backend error using its message and next step", () => {
    const { out } = capture(() =>
      renderCliError(new Error('404: {"error":"not_found","message":"No such entity","next":"Run ix map"}')),
    );
    expect(out).toContain("No such entity");
    expect(out).toContain("Run ix map");
  });

  it("renders usage errors with their hint", () => {
    const { out } = capture(() => renderCliError(new CliUsageError("Bad flag", "Try --kind class")));
    expect(out).toContain("Bad flag");
    expect(out).toContain("Try --kind class");
  });

  it("shows resolution detail only in debug mode", () => {
    const err = new CliResolutionError("Ambiguous", "Narrow it down", "3 candidates");
    expect(capture(() => renderCliError(err, false)).out).not.toContain("3 candidates");
    expect(capture(() => renderCliError(err, true)).out).toContain("3 candidates");
  });

  it("appends the stack only in debug mode", () => {
    const err = fetchFailure("ECONNREFUSED");
    err.stack = "TypeError: fetch failed\n    at node:internal/deps/undici/undici:14976:13";
    expect(capture(() => renderCliError(err, false, "http://x")).out).not.toContain("node:internal");
    expect(capture(() => renderCliError(err, true, "http://x")).out).toContain("node:internal");
  });

  it("does not tell a remote user to start Docker", () => {
    // Pro syncs config.endpoint to a cloud instance; `ix docker start` cannot
    // fix that endpoint and starts a backend the user is not pointed at.
    const { out } = capture(() =>
      renderCliError(fetchFailure("ECONNREFUSED"), false, "https://prod.cloud.ix-infra.com"),
    );
    expect(out).toContain("Ix backend not reachable at https://prod.cloud.ix-infra.com");
    expect(out).not.toContain("ix docker start");
    expect(out).toContain("ix config get endpoint");
  });

  it("keeps the docker remedy for a loopback endpoint", () => {
    const { out } = capture(() =>
      renderCliError(fetchFailure("ECONNREFUSED"), false, "http://127.0.0.1:8090"),
    );
    expect(out).toContain("ix docker start");
  });

  it("shows the cause chain in debug mode when the error carries no stack", () => {
    // The case this module exists for: Node's fetch TypeError loses its frames
    // across the async boundary, so `err.stack` alone renders nothing useful.
    const err = fetchFailure("ECONNREFUSED");
    err.stack = undefined;
    const { out } = capture(() => renderCliError(err, true, "http://localhost:8090"));
    expect(out).toContain("ECONNREFUSED");
  });

  it("does not print arbitrary error properties in debug mode", () => {
    // This is the process-wide boundary. Dumping every own property of whatever
    // was thrown would put credentials into output the user pastes into an issue.
    const err = Object.assign(new Error("boom"), {
      request: { headers: { authorization: "Bearer sk-SECRET-TOKEN" } },
    });
    const { out } = capture(() => renderCliError(err, true));
    expect(out).toContain("boom");
    expect(out).not.toContain("sk-SECRET-TOKEN");
  });

  it("does not throw on null or undefined", () => {
    expect(capture(() => renderCliError(null)).exited).toBe(true);
    expect(capture(() => renderCliError(undefined)).exited).toBe(true);
  });
});

describe("formatFetchError", () => {
  it("appends the nested cause code and message", () => {
    expect(formatFetchError(fetchFailure("ECONNREFUSED"))).toContain("ECONNREFUSED");
  });

  it("passes non-fetch errors through untouched", () => {
    expect(formatFetchError(new Error("plain"))).toBe("plain");
  });
});
