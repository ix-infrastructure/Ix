// Slot for an optional remote ingestion runner (filled by @ix/pro at runtime).
// OSS commands that support cloud routing (currently `ix map`) check
// isRemoteReady() and call runRemoteIngestion() instead of local ingest when
// a runner is registered and reports ready.

export interface RemoteIngestOptions {
  cwd: string;
}

interface RemoteRunner {
  isReady(): Promise<boolean>;
  runIngestion(opts: RemoteIngestOptions): Promise<void>;
}

let _runner: RemoteRunner | undefined;

export function registerRemoteRunner(runner: RemoteRunner): void {
  _runner = runner;
}

export async function isRemoteReady(): Promise<boolean> {
  if (!_runner) return false;
  return _runner.isReady();
}

export async function runRemoteIngestion(opts: RemoteIngestOptions): Promise<void> {
  if (!_runner) throw new Error("No remote runner registered");
  return _runner.runIngestion(opts);
}
