import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createHosts,
  isOnPath,
  SERVER_NAME,
  type HostStatus,
  type McpHost,
  type Registration,
} from "./hosts.js";
import { IX_MCP_OSS_TOOL_NAMES, IX_MCP_PRO_TOOL_NAMES } from "./server.js";
import { detectPro } from "./runner.js";

/** What install decided to do about one host. */
export type Outcome =
  | "registered"
  | "already-registered"
  | "conflict"
  | "not-installed"
  | "failed"
  | "would-register"
  /** Doctor only: host is present and the name is free, but nothing points at us. */
  | "not-registered";

export interface HostReport extends HostStatus {
  outcome: Outcome;
  target: string;
  /** Why it was skipped, or how it failed. */
  note?: string;
}

export interface InstallReport {
  hosts: HostReport[];
  registered: number;
  conflicts: number;
}

export interface DoctorReport {
  /** Hosts launch the bare command `ix`; if that does not resolve, every registration is dead. */
  ixOnPath: boolean;
  toolCount: number;
  hosts: HostReport[];
}

export interface InstallOptions {
  hosts?: McpHost[];
  /** Restrict to these host ids. */
  only?: string[];
  dryRun?: boolean;
  /** Replace a name held by something else. Off by default: never clobber. */
  force?: boolean;
}

/**
 * Merge into a JSON config in place, keeping a `.bak` of what was there.
 *
 * Only used for the two hosts with no usable CLI. Everything the user already
 * had is preserved: the file is parsed, mutated, and re-serialised, so an
 * unrelated key cannot be dropped, and the backup makes a bad merge reversible.
 */
export function writeJsonConfig(path: string, mutate: (config: Record<string, unknown>) => void): void {
  let config: Record<string, unknown> = {};
  const exists = existsSync(path);

  if (exists) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Refuse rather than overwrite: a file we cannot parse is a file whose
        // contents we would be destroying.
        throw new Error(`${path} is not valid JSON — fix or move it, then re-run`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path} is not a JSON object`);
      }
      config = parsed as Record<string, unknown>;
    }
    copyFileSync(path, `${path}.bak`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  mutate(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function outcomeFor(registration: Registration, force: boolean): Exclude<Outcome, "not-installed" | "failed"> | null {
  if (registration === "none") return null; // proceed
  if (registration === "ours") return "already-registered";
  return force ? null : "conflict";
}

function noteFor(registration: Registration, detail?: string): string | undefined {
  if (registration === "other") {
    return detail
      ? `'${SERVER_NAME}' already points at something else: ${detail}`
      : `'${SERVER_NAME}' is already registered to a different server`;
  }
  if (registration === "unknown") {
    return detail ? `could not read current registration (${detail})` : "could not read current registration";
  }
  return detail;
}

export async function runInstall(options: InstallOptions = {}): Promise<InstallReport> {
  const hosts = (options.hosts ?? createHosts(writeJsonConfig)).filter(
    (host) => !options.only?.length || options.only.includes(host.id),
  );

  const reports: HostReport[] = [];

  for (const host of hosts) {
    const base = { id: host.id, label: host.label, target: host.target };

    if (!(await isOnPath(host.bin))) {
      reports.push({ ...base, installed: false, registration: "none", outcome: "not-installed" });
      continue;
    }

    const { registration, detail } = await host.inspect();
    const blocked = outcomeFor(registration, options.force === true);
    if (blocked) {
      reports.push({ ...base, installed: true, registration, outcome: blocked, note: noteFor(registration, detail) });
      continue;
    }

    if (options.dryRun) {
      reports.push({ ...base, installed: true, registration, outcome: "would-register" });
      continue;
    }

    try {
      await host.register();
      reports.push({ ...base, installed: true, registration, outcome: "registered" });
    } catch (error) {
      reports.push({
        ...base,
        installed: true,
        registration,
        outcome: "failed",
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    hosts: reports,
    registered: reports.filter((r) => r.outcome === "registered").length,
    conflicts: reports.filter((r) => r.outcome === "conflict").length,
  };
}

export async function runDoctor(options: { hosts?: McpHost[]; only?: string[] } = {}): Promise<DoctorReport> {
  const hosts = (options.hosts ?? createHosts(writeJsonConfig)).filter(
    (host) => !options.only?.length || options.only.includes(host.id),
  );

  const reports: HostReport[] = [];
  for (const host of hosts) {
    const base = { id: host.id, label: host.label, target: host.target };
    if (!(await isOnPath(host.bin))) {
      reports.push({ ...base, installed: false, registration: "none", outcome: "not-installed" });
      continue;
    }
    const { registration, detail } = await host.inspect();
    reports.push({
      ...base,
      installed: true,
      registration,
      outcome:
        registration === "ours" ? "already-registered" : registration === "none" ? "not-registered" : "conflict",
      note: noteFor(registration, detail),
    });
  }

  return {
    ixOnPath: await isOnPath("ix"),
    // What this install actually advertises, not the theoretical maximum.
    toolCount: IX_MCP_OSS_TOOL_NAMES.length + (await detectPro() ? IX_MCP_PRO_TOOL_NAMES.length : 0),
    hosts: reports,
  };
}
