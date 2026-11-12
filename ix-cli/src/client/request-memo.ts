// Copyright 2026 Ix Infrastructure Inc.

/**
 * Per-command request sharing for the read paths of `IxClient`.
 *
 * The query commands build their answer from many small reads, and several
 * collectors ask the same question independently: `ix context --from-issue`
 * walks each starting point's neighbourhood with the same helpers, so the
 * files they share are expanded once per starting point -- measured at 56 of
 * 225 requests on one issue against the Ix repository's own graph. Sharing a
 * read by its exact request (method, path, body) removes those without any
 * collector having to know about the others.
 *
 * Scope is one command invocation: `IxClient.shareReads()` is called on the
 * client an action handler creates, and that client is dropped when the
 * command returns. It is never enabled on a long-lived client (`ix watch`, the
 * MCP server), where a read after a write must see the write.
 *
 * What is cached is the response TEXT, not the parsed value: every caller
 * parses its own copy, so a caller that sorts or edits the arrays it was
 * handed cannot change what another caller sees. A miss costs nothing extra --
 * the first caller's parse is the one it always did.
 *
 * A failed read is not kept unless the caller identifies it as a stable miss
 * (an entity 404). Transient failures still go back to the backend next time.
 */
export class RequestMemo<V> {
  private readonly entries = new Map<string, Promise<V>>();
  /** Requests answered from the memo rather than the backend. */
  hits = 0;

  run(key: string, load: () => Promise<V>, keepFailure?: (err: unknown) => boolean): Promise<V> {
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      return existing;
    }
    const pending = load();
    this.entries.set(key, pending);
    pending.catch((err: unknown) => {
      if (!keepFailure?.(err) && this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }
}

/**
 * At most `max` tasks in flight; the rest wait in arrival order.
 *
 * Lets the collectors run independent steps concurrently without each one
 * multiplying the load on a backend other workspaces share. Only leaf work
 * (one HTTP round trip) runs under it, so a task never waits for a slot while
 * holding one, and it cannot deadlock.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Limiter max must be a positive integer, got ${max}`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next task rather than releasing it, so a
      // task arriving in between cannot overtake one that has been waiting.
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * `fn` over `items` with at most `limit` calls in flight, results in input
 * order. The order of completion never reaches the result, so a caller that
 * renders it renders the same thing on every run.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * The options a one-shot query command creates its client with: repeated
 * reads shared, and at most this many requests in flight. The cap is what the
 * graph walkers already used (`trace`, `depends`, related files: 8) with room
 * for the independent steps of `collectFacts` to overlap.
 *
 * Kept here rather than in `api.ts` so a test that mocks the client module
 * still gets the value.
 */
export const QUERY_CLIENT_OPTIONS = { shareReads: true, maxInFlight: 12 } as const;
