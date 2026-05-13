// Optional extension point for a remote-ingestion backend.
//
// OSS ships no remote implementation. A Pro module (or other extension)
// registers a RemoteRunner at load time via registerRemoteRunner(). OSS
// command handlers look it up via getRemoteRunner() and route through
// it automatically when isCloudReady() returns true — no per-command
// --remote flag required. A --local opt-out is still available for
// users who want to force local execution.

export interface RemoteIngestOptions {
  cwd: string;
  silent?: boolean;
  format?: "text" | "json" | string;
}

export interface RemoteRunner {
  runIngestion(opts: RemoteIngestOptions): Promise<void>;
  /**
   * Optional readiness probe. Returns true when the runner is fully
   * configured (Pro loaded AND the user has set an active cloud
   * instance with an orgId). Pure local check — must NOT hit the
   * network; reachability is verified lazily inside runIngestion.
   *
   * Absent on legacy runners; in that case isCloudReady() treats the
   * runner as ready whenever it's registered.
   */
  isReady?(): Promise<boolean>;
}

let registered: RemoteRunner | null = null;

export function registerRemoteRunner(runner: RemoteRunner): void {
  registered = runner;
}

export function getRemoteRunner(): RemoteRunner | null {
  return registered;
}

/**
 * True if a remote runner is registered AND it reports itself as ready.
 * Commands that auto-route between local and cloud (e.g. `ix map`) call
 * this once to decide which path to take. Pure local check — no network
 * I/O. Failure of the runner's isReady() falls back to "not ready".
 */
export async function isCloudReady(): Promise<boolean> {
  if (!registered) return false;
  if (!registered.isReady) return true; // legacy runner: registered => ready
  try {
    return await registered.isReady();
  } catch {
    return false;
  }
}
