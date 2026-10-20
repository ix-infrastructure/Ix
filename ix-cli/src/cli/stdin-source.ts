// Copyright 2026 Ix Infrastructure Inc.

import { Readable } from "node:stream";

/**
 * Where a command reads its standard input from.
 *
 * Normally `process.stdin`. The warm daemon (`cli/daemon/`) runs commands in
 * its own process, whose stdin is not the caller's: the client reads the
 * caller's stdin and the daemon feeds those bytes here for the length of one
 * run. The client feeds it too when it has read stdin and then runs the
 * command itself after all, since the bytes are no longer on the pipe.
 *
 * Every command that reads stdin reads it through {@link commandStdin}, and
 * only the invocations named in `daemon/protocol.ts` (`STDIN_INVOCATIONS`) may
 * do so: an inherited pipe may never close, so nothing else reads it at all.
 */

let fed: Buffer | undefined;

/** Feed `bytes` as stdin to whatever runs next; undefined goes back to the real one. */
export function feedStdin(bytes: Buffer | undefined): void {
  fed = bytes;
}

/** This run's stdin: the fed bytes as a stream that then ends, or `process.stdin`. */
export function commandStdin(): NodeJS.ReadableStream & { isTTY?: boolean } {
  if (fed === undefined) return process.stdin;
  return Readable.from(fed.length > 0 ? [fed] : []);
}
