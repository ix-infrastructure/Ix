// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";

// Kept for @ix/pro, which imports it from `cli/config.js`. The factory itself is
// the synchronous `createClient` in client/factory.ts. This wrapper loads it
// lazily so that importing `cli/config.js` does not load the HTTP client.
export async function createClient(): Promise<IxClient> {
  const factory = await import("../client/factory.js");
  // Pro's client may outlive one command: no read deadline.
  return factory.createClient({ longRunning: true });
}
