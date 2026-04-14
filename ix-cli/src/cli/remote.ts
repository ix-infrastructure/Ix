// Optional extension point for a remote-ingestion backend.
//
// OSS declares the --remote flag on commands that support remote
// ingestion (e.g. `ix map`) but ships no implementation. A Pro
// module (or other extension) registers a RemoteRunner at load
// time via registerRemoteRunner(); OSS command handlers look it up
// via getRemoteRunner() and fail with an actionable error when
// absent.

export interface RemoteIngestOptions {
  cwd: string;
  silent?: boolean;
  format?: "text" | "json" | string;
}

export interface RemoteRunner {
  runIngestion(opts: RemoteIngestOptions): Promise<void>;
}

let registered: RemoteRunner | null = null;

export function registerRemoteRunner(runner: RemoteRunner): void {
  registered = runner;
}

export function getRemoteRunner(): RemoteRunner | null {
  return registered;
}
