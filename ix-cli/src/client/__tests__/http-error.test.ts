// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { httpError, LocalTokenRequiredError } from "../api.js";

// `httpError`'s message is read back by many callers (status prefixes, error
// codes in the JSON body), so the headers it now takes for the commit retry
// (IN-19C) may add properties and must not touch the message.
describe("httpError", () => {
  const body = '{"error":"service unavailable"}';

  it("keeps the message byte-identical and carries status and Retry-After when given headers", () => {
    const err = httpError(503, body, new Headers({ "Retry-After": "2" })) as Error & { status?: number; retryAfter?: string };
    expect(err.message).toBe(`503: ${body}`);
    expect(err.message).toBe(httpError(503, body).message);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe("2");
    // Non-enumerable: nothing that serialises or spreads an error picks them up.
    expect(Object.keys(err)).toEqual([]);
  });

  it("has no Retry-After when the response had none", () => {
    const err = httpError(502, "bad gateway", new Headers()) as Error & { status?: number; retryAfter?: string };
    expect(err.status).toBe(502);
    expect("retryAfter" in err).toBe(false);
  });

  it("adds nothing without headers", () => {
    const err = httpError(503, body);
    expect(err.message).toBe(`503: ${body}`);
    expect("status" in err).toBe(false);
    expect("retryAfter" in err).toBe(false);
  });

  it("still raises LocalTokenRequiredError for the loopback guard's 401", () => {
    const guard = '{"code":"local_token_required","error":"token required"}';
    const err = httpError(401, guard, new Headers({ "Retry-After": "1" }));
    expect(err).toBeInstanceOf(LocalTokenRequiredError);
    expect(err.message).toBe(`401: ${guard}`);
    expect("retryAfter" in err).toBe(false);
  });
});
