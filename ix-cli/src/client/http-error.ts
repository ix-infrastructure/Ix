// Copyright 2026 Ix Infrastructure Inc.

/** Marks an `IxHttpError` from any copy of this module (`Symbol.for` is process-wide). */
const BRAND = Symbol.for("ix.IxHttpError");

/**
 * A request the backend (or whatever sits in front of it) answered, but not
 * with a usable response: a non-2xx, or a 2xx whose body is not JSON (see
 * `parseOrThrowWithStatus` in api.ts). Read `status`, `code` and `body` off the error;
 * never parse them back out of the message (#940).
 *
 * The message is `<status>: <body>`, exactly as it was when this was a plain
 * Error, because users see it and code outside this package may still read it.
 * `name` stays "Error" for the same reason: `String(err)` is unchanged.
 *
 * Every field is non-enumerable, so nothing that serialises, spreads or
 * inspects an error picks them up.
 *
 * Test for one with `isIxHttpError`, not `instanceof`: a second copy of this
 * module (another install of the package, or a test's `vi.resetModules`) has
 * its own class, and `instanceof` against the other copy is false.
 */
export class IxHttpError extends Error {
  /** The HTTP status, the same number the message starts with. */
  declare readonly status: number;
  /**
   * The response body as the message holds it: a JSON body whole, anything
   * else cut short (`errorBodyForMessage`).
   */
  declare readonly body: string;
  /**
   * The `code` string of a JSON object body, when it has one. It is the
   * server's word, never a Node socket code: anything that walks `.code` for
   * ECONNREFUSED and the like must skip an `IxHttpError`, which by definition
   * got an answer.
   */
  declare readonly code?: string;
  /** The raw `Retry-After` header, when it was read and the response had one. */
  declare readonly retryAfter?: string;

  constructor(status: number, body: string, opts: { retryAfter?: string | null; message?: string } = {}) {
    super(opts.message ?? `${status}: ${body}`);
    define(this, BRAND, true);
    define(this, "status", status);
    define(this, "body", body);
    const code = jsonCode(body);
    if (code !== undefined) define(this, "code", code);
    if (opts.retryAfter !== undefined && opts.retryAfter !== null) define(this, "retryAfter", opts.retryAfter);
  }
}

/** Whether `err` is an `IxHttpError`, built by this copy of the module or any other. */
export function isIxHttpError(err: unknown): err is IxHttpError {
  return typeof err === "object" && err !== null && (err as { [BRAND]?: unknown })[BRAND] === true;
}

/**
 * Configurable, so a subclass may declare one of these as its own field
 * (`LocalTokenRequiredError.code`).
 */
function define(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: true });
}

/** The `code` string of a JSON object body, when it has one. */
export function jsonCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The HTTP status of a request that failed with an `IxHttpError`; undefined for any other failure. */
export function httpStatusOf(err: unknown): number | undefined {
  return isIxHttpError(err) ? err.status : undefined;
}
