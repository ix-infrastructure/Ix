import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getDataDir, getStateDir, getEndpoint } from "./config.js";

export function getServerPidPath(): string {
  return join(getStateDir(), "ix-server.pid");
}

export function getServerLogPath(): string {
  return join(getStateDir(), "ix-server.log");
}

export function getServerJarPath(): string {
  return join(getDataDir(), "server", "ix-memory-layer.jar");
}

export function readPid(): number | null {
  const pidPath = getServerPidPath();
  if (!existsSync(pidPath)) return null;
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isServerRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  if (!isProcessAlive(pid)) {
    // Stale PID file
    try { unlinkSync(getServerPidPath()); } catch {}
    return false;
  }
  return true;
}

export async function healthCheck(timeoutMs = 5000): Promise<boolean> {
  const endpoint = getEndpoint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/v1/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHealth(maxWaitMs = 30000, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await healthCheck(2000)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

export async function startServer(): Promise<{ pid: number }> {
  if (isServerRunning()) {
    const pid = readPid()!;
    return { pid };
  }

  const jarPath = getServerJarPath();
  if (!existsSync(jarPath)) {
    throw new Error(`Server JAR not found at ${jarPath}. Run 'ix upgrade' or reinstall.`);
  }

  const stateDir = getStateDir();
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const logPath = getServerLogPath();
  const logFd = openSync(logPath, "a");

  const dataDir = join(getDataDir(), "data", "graph");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const child = spawn("java", [
    "-jar", jarPath,
  ], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      IX_DATA_DIR: dataDir,
    },
  });

  child.unref();

  if (!child.pid) throw new Error("Failed to start server process");

  writeFileSync(getServerPidPath(), String(child.pid));

  const healthy = await waitForHealth();
  if (!healthy) {
    throw new Error("Server started but failed health check. Check logs: " + logPath);
  }

  return { pid: child.pid };
}

export async function stopServer(): Promise<void> {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    // Clean up stale PID
    try { unlinkSync(getServerPidPath()); } catch {}
    return;
  }

  process.kill(pid, "SIGTERM");

  // Wait for graceful shutdown (up to 10s)
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (!isProcessAlive(pid)) break;
    await new Promise(r => setTimeout(r, 200));
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }

  try { unlinkSync(getServerPidPath()); } catch {}
}

export async function ensureServer(): Promise<void> {
  if (await healthCheck(2000)) return;
  await startServer();
}

export async function getServerVersion(): Promise<{ version: string; schemaVersion: number } | null> {
  const endpoint = getEndpoint();
  try {
    const res = await fetch(`${endpoint}/v1/version`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
