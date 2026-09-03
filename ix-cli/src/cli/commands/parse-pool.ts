/**
 * Bounded worker-thread pool for parallel file parsing.
 * Uses the core-ingestion parse-worker entry compiled to dist/.
 *
 * - Bounded to `concurrency` simultaneous workers.
 * - One crashed worker is replaced; its in-flight task resolves as null (treated as parse failure).
 * - parse() returns a Promise that resolves to FileParseResult | null.
 * - Results collected via Promise.all preserve input ordering.
 */
import { Worker } from 'node:worker_threads';

type Task = {
  filePath: string;
  source: string;
  resolve: (result: unknown) => void;
};

export class ParsePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private active = new Map<Worker, Task>();

  constructor(private workerPath: string, private concurrency: number) {}

  init(): void {
    for (let i = 0; i < this.concurrency; i++) {
      this.spawnWorker();
    }
  }

  parse(filePath: string, source: string): Promise<unknown> {
    return new Promise((resolve) => {
      this.queue.push({ filePath, source, resolve });
      this.drain();
    });
  }

  async destroy(): Promise<void> {
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.idle = [];
  }

  private spawnWorker(): Worker {
    const w = new Worker(this.workerPath);
    w.on('message', (msg: { ok: boolean; result: unknown }) => this.onResult(w, msg));
    w.on('error', (err) => this.onError(w, err));
    this.workers.push(w);
    this.idle.push(w);
    return w;
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.active.set(w, task);
      w.postMessage({ filePath: task.filePath, source: task.source });
    }
  }

  /**
   * In-flight tasks lost to a crashed worker.
   *
   * `parse()` resolves `null` for two very different things, and collapsing
   * them hid a real difference (Ix#568): a worker that CRASHED lost a file it
   * would otherwise have parsed, which is transient and makes the run's results
   * incomplete -- while `parseFile` returning null is deterministic and says
   * this file has nothing to give, most often because its grammar is an
   * unavailable optional dependency (`tree-sitter-sas` has no win32 prebuild,
   * for one). Callers that need "did we miss anything we would have indexed?"
   * must ask this and not count nulls.
   */
  crashedTasks(): number {
    return this.crashed;
  }

  private onResult(w: Worker, msg: { ok: boolean; result: unknown }): void {
    const task = this.active.get(w);
    if (!task) return;
    this.active.delete(w);
    task.resolve(msg.ok ? msg.result : null);
    this.idle.push(w);
    this.drain();
  }

  private crashed = 0;

  private onError(w: Worker, _err: Error): void {
    const task = this.active.get(w);
    if (task) {
      this.active.delete(w);
      this.crashed++;
      task.resolve(null); // isolate: failed file = null parse result
    }
    // Replace the crashed worker
    const idx = this.workers.indexOf(w);
    if (idx !== -1) {
      w.terminate().catch(() => {});
      this.workers.splice(idx, 1);
      this.spawnWorker();
      this.drain();
    }
  }
}
