import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getCacheDir } from "./config.js";

export interface PlatformInfo {
  archive: string;
  sha256: string;
}

export interface RemoteManifest {
  version: string;
  channel: string;
  schemaVersion: number;
  released: string;
  platforms: Record<string, PlatformInfo>;
}

export interface LocalManifest {
  version: string;
  channel: string;
  installedAt: string;
  platform: string;
  schemaVersion: number;
  previousVersion?: string;
}

const GITHUB_ORG = "ix-infrastructure";
const GITHUB_REPO = "IX-Memory";

export function getManifestPath(): string {
  return join(getDataDir(), "manifest.json");
}

export function readLocalManifest(): LocalManifest | null {
  const p = getManifestPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeLocalManifest(manifest: LocalManifest): void {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

export async function fetchRemoteManifest(channel = "stable"): Promise<RemoteManifest> {
  const url = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ix-cli" },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release = (await res.json()) as any;
  const asset = release.assets?.find((a: any) => a.name === "manifest.json");
  if (!asset) throw new Error("No manifest.json found in latest release");
  const manifestRes = await fetch(asset.browser_download_url);
  if (!manifestRes.ok) throw new Error(`Failed to download manifest: ${manifestRes.status}`);
  return (await manifestRes.json()) as RemoteManifest;
}

export async function fetchRemoteManifestForVersion(version: string): Promise<RemoteManifest> {
  const url = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/tags/v${version}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ix-cli" },
  });
  if (!res.ok) throw new Error(`Release v${version} not found: ${res.status}`);
  const release = (await res.json()) as any;
  const asset = release.assets?.find((a: any) => a.name === "manifest.json");
  if (!asset) throw new Error(`No manifest.json in release v${version}`);
  const manifestRes = await fetch(asset.browser_download_url);
  if (!manifestRes.ok) throw new Error(`Failed to download manifest: ${manifestRes.status}`);
  return (await manifestRes.json()) as RemoteManifest;
}

export function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}

export function getDownloadDir(): string {
  return join(getCacheDir(), "downloads");
}

export function getBackupDir(): string {
  return join(getDataDir(), "backups");
}
