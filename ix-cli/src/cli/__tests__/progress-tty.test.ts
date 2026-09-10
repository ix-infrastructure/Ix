// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it } from "vitest";

import { canRenderProgress } from "../stderr.js";

const original = process.stderr.isTTY;

afterEach(() => {
  process.stderr.isTTY = original;
});

// The progress bars in ingest.ts, map.ts and reset.ts all animate by writing
// `\r` and overwriting the line. That only overwrites on a terminal — into a
// redirect, a pipe or a CI log every 80 ms frame is kept, so output grew with
// elapsed time rather than with work done. Each of those three gated on
// something else entirely (format, --silent, nothing at all), and none of them
// asked whether anyone was watching.
describe("canRenderProgress", () => {
  it("is true on a terminal", () => {
    process.stderr.isTTY = true;
    expect(canRenderProgress()).toBe(true);
  });

  it("is false when stderr is redirected", () => {
    process.stderr.isTTY = false;
    expect(canRenderProgress()).toBe(false);
  });

  it("is false when isTTY is undefined, which is what a pipe actually gives", () => {
    // Node does not set isTTY to false on a non-tty stream — it leaves the
    // property off entirely. So a helper written as `isTTY === false`, and a
    // test that only ever assigned false, would both pass while every real
    // redirect still animated. That is the case this whole fix is about, so it
    // is the case the test has to construct.
    delete (process.stderr as { isTTY?: boolean }).isTTY;
    expect(canRenderProgress()).toBe(false);
  });
});
