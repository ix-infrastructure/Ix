// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import {
  BROWSER_LOOPBACK_HOSTNAMES,
  DEFAULT_ENDPOINT,
  isLoopbackEndpoint,
  isManagedLocalBackend,
} from "../endpoint.js";
import { isLocalEndpoint } from "../backend-version.js";
import { DEFAULT_ENDPOINT as CONFIG_DEFAULT_ENDPOINT } from "../config.js";
import { canAutoStartBackend } from "../bootstrap.js";
import { backendUnreachableError, localTokenRequiredError } from "../errors.js";
import { stitchKey } from "../stitch-guard.js";
import { IxClient } from "../../client/api.js";

/**
 * "Is this endpoint this machine?" used to be answered five ways. These tests
 * pin that every caller now gets the same answer from the one predicate.
 */

/** IxClient's reset-path decision; private, so reached the way reset-redirect.test.ts reaches it. */
const resetIsLocal = (endpoint: string): boolean =>
  (new IxClient(endpoint) as unknown as { isLocalEndpoint(): boolean }).isLocalEndpoint();

const unreachableSuggestsDockerStart = (endpoint?: string): boolean =>
  backendUnreachableError(endpoint).next!.includes("ix docker start");

describe("endpoint module", () => {
  it("is the one predicate the token rule uses", () => {
    expect(isLocalEndpoint).toBe(isLoopbackEndpoint);
    expect(CONFIG_DEFAULT_ENDPOINT).toBe(DEFAULT_ENDPOINT);
    expect(new IxClient().endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("knows the managed local backend is loopback on the default port", () => {
    expect(isManagedLocalBackend(DEFAULT_ENDPOINT)).toBe(true);
    for (const e of [
      "http://127.0.0.1:8090/",
      "http://[::1]:8090",
      "http://127.0.0.2:8090",
      "http://localhost.:8090",
    ]) {
      expect(isManagedLocalBackend(e)).toBe(true);
    }
    for (const e of [
      "http://localhost:8100",
      "http://localhost",
      "http://staging:8090",
      "https://ix.example.com",
      "nope",
    ]) {
      expect(isManagedLocalBackend(e)).toBe(false);
    }
  });

  it("keeps the view server's inbound host list a narrow subset of loopback", () => {
    // An inbound guard: widening it would loosen the DNS-rebinding check.
    expect([...BROWSER_LOOPBACK_HOSTNAMES]).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    for (const h of BROWSER_LOOPBACK_HOSTNAMES)
      expect(isLoopbackEndpoint(`http://${h}:1`)).toBe(true);
  });
});

describe("every caller agrees on what is local", () => {
  // The cases from the issue: each one used to get different answers from
  // the token rule, the reset path, the hint and auto-start.
  it.each([
    "http://[::1]:8090",
    "http://127.0.0.2:8090",
    "http://localhost:8090",
    "http://0.0.0.0:8090",
  ])("%s is the local managed backend everywhere", (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(true); // token is sent
    expect(resetIsLocal(endpoint)).toBe(true); // reset takes the direct sync path
    expect(unreachableSuggestsDockerStart(endpoint)).toBe(true); // hint
    expect(canAutoStartBackend(endpoint)).toBe(true); // auto-start
    expect(localTokenRequiredError(endpoint).next).toContain("ix docker start --local-token");
  });

  it("a loopback backend on another port is local, but not one `ix docker start` serves", () => {
    const endpoint = "http://localhost:8100";
    expect(isLocalEndpoint(endpoint)).toBe(true);
    expect(resetIsLocal(endpoint)).toBe(true);
    expect(canAutoStartBackend(endpoint)).toBe(false);
    expect(unreachableSuggestsDockerStart(endpoint)).toBe(false);
    // The token is sent to it, so the "only to a backend on this machine"
    // advice would be false; and `ix docker start` would start a different backend.
    const next = localTokenRequiredError(endpoint).next!;
    expect(next).not.toContain("ix docker start");
    expect(next).not.toMatch(/only to a backend on this machine/);
    expect(next).toContain("IX_TOKEN");
  });

  it.each(["https://ix.example.com", "http://staging:8090", "http://127.0.0.1.evil.com:8090"])(
    "%s is remote everywhere",
    (endpoint) => {
      expect(isLocalEndpoint(endpoint)).toBe(false);
      expect(resetIsLocal(endpoint)).toBe(false);
      expect(unreachableSuggestsDockerStart(endpoint)).toBe(false);
      expect(canAutoStartBackend(endpoint)).toBe(false);
    },
  );

  it("an unresolved endpoint means the default local install", () => {
    expect(unreachableSuggestsDockerStart(undefined)).toBe(true);
    expect(localTokenRequiredError(undefined).next).toContain("ix docker start --local-token");
  });

  it("the stitch lock folds every loopback spelling of one backend together", () => {
    const key = stitchKey("http://localhost:8090");
    for (const e of [
      "http://127.0.0.1:8090/",
      "http://[::1]:8090",
      "http://127.0.0.2:8090",
      "http://LOCALHOST.:8090",
    ]) {
      expect(stitchKey(e)).toBe(key);
    }
    expect(stitchKey("http://staging:8090")).not.toBe(key);
  });
});
