import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createHosts,
  isOnPath,
  SERVER_NAME,
  stripJsonComments,
  type HostStatus,
  type McpHost,
  type Registration,
} from "./hosts.js";
import { discoverTools, type ToolDiscovery } from "./discovery.js";
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
  | "not-registered"
  /** Doctor only: ours, but the launcher path it records is gone. */
  | "stale";

/** Which probe decided a host's presence. */
type DetectionVia = "toolscan" | "path" | "config-dir" | "none";

export interface HostReport extends HostStatus {
  outcome: Outcome;
  target: string;
  /**
   * Which probe decided presence: toolscan's scan, the PATH probe, a config
   * directory, or `none` when the host is absent. Makes the toolscan seam
   * auditable: a host toolscan found reads `toolscan` even when its CLI also
   * happens to be on PATH.
   */
  detectedVia: DetectionVia;
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
  /**
   * Tool discovery (toolscan when available, embedded checks otherwise).
   * Injectable so tests can feed a fixed discovery.
   */
  discover?: () => Promise<ToolDiscovery>;
}

/**
 * Read a config file, distinguishing "absent" from "unreadable".
 *
 * Reading straight out instead of checking existsSync first is what closes
 * CodeQL js/file-system-race — the same fix view.ts carries for the same rule.
 * The check could always go stale before the read, and it never told us the
 * read would succeed anyway.
 *
 * Only ENOENT means absent. Anything else has to surface: collapsing
 * "unreadable" into "absent" here would take the mkdir-and-write branch and
 * overwrite a config we merely failed to read — with no `.bak`, since the copy
 * only happens on the branch that read something.
 */
function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
  const raw = readTextIfPresent(path);

  if (raw !== null) {
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        // Comments are stripped for the same reason the read path strips them:
        // VS Code and Cursor both accept JSON-with-comments here. Parsing raw
        // meant a hand-annotated config passed `inspect`, reported its name as
        // free, and then hard-failed the write telling the user to fix a file
        // their editor reads without complaint. The `.bak` below is what makes
        // losing those comments recoverable.
        parsed = JSON.parse(stripJsonComments(raw));
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
  // Already ours, just pointing at a launcher that no longer exists. Rewriting
  // it is the repair, and it needs no --force: nothing of the user's is at risk.
  if (registration === "stale") return null;
  return force ? null : "conflict";
}

/**
 * The hosts named by `--host`, or all of them.
 *
 * An unrecognised id used to filter every host out and report success, so a
 * typo in a setup script (`--host claude-code`, when the id is `claude`)
 * registered nothing and exited 0.
 */
function selectHosts(all: McpHost[], only?: string[]): McpHost[] {
  if (!only?.length) return all;
  const known = new Set(all.map((host) => host.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown host ${unknown.map((id) => `'${id}'`).join(", ")} — known hosts: ${[...known].join(", ")}`,
    );
  }
  return all.filter((host) => only.includes(host.id));
}

/**
 * Whether the host is present, and which probe decided.
 *
 * The toolscan seam only ever adds evidence: a harness whose CLI toolscan
 * found is present no matter what the embedded probe says. It never overrides
 * a negative — a config-dir host (cursor, vscode, opencode) is present with
 * no CLI on PATH, and toolscan's bounded scan can truncate — so the embedded
 * check still runs whenever toolscan does not name the bin.
 *
 * Probe order is also the honesty order for `detectedVia`: PATH is checked
 * before the config-dir probe, so a host whose CLI resolves on PATH is
 * reported as found *on PATH* rather than misattributed to its config
 * directory (which cursor/vscode/opencode's combined check would otherwise
 * claim).
 */
async function hostInstalled(
  host: McpHost,
  discovery: ToolDiscovery,
): Promise<{ installed: boolean; via: DetectionVia }> {
  // A toolscan entry must carry the path that makes its verdict executable:
  // `inspect`/`register` run whatever `paths` names for an off-PATH harness,
  // so a name-only entry (truncated scan) that flips presence here would fall
  // through to a bare-name PATH exec that ENOENTs into a false `conflict`.
  // Requiring the path degrades such entries to the embedded probes instead
  // of inventing a presence toolscan did not actually establish.
  if (
    discovery.names.has(host.bin.toLowerCase()) &&
    discovery.paths.has(host.bin.toLowerCase())
  ) {
    return { installed: true, via: "toolscan" };
  }
  if (await isOnPath(host.bin)) return { installed: true, via: "path" };
  if (host.detectInstalled) {
    return (await host.detectInstalled())
      ? { installed: true, via: "config-dir" }
      : { installed: false, via: "none" };
  }
  return { installed: false, via: "none" };
}

/**
 * The absolute CLI path toolscan found for a host, if any.
 *
 * Without this, a harness whose CLI is installed off PATH (the seam's own
 * motivating case) reads as an unreadable registration — `unknown`, which
 * `install` reports as a conflict and `--force` turns into a failed
 * registration. Toolscan's scan covers the install roots beyond PATH, so its
 * reported path is exactly the command `inspect`/`register` must execute.
 */
function toolscanBin(host: McpHost, discovery: ToolDiscovery): string | undefined {
  return discovery.paths.get(host.bin.toLowerCase());
}

function noteFor(registration: Registration, detail?: string): string | undefined {
  if (registration === "stale") {
    return detail
      ? `registered, but its launcher is gone: ${detail}`
      : "registered, but the launcher path it records no longer exists";
  }
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
  const hosts = selectHosts(options.hosts ?? createHosts(writeJsonConfig), options.only);
  const discovery = await (options.discover ?? discoverTools)();

  const reports: HostReport[] = [];

  for (const host of hosts) {
    const base = { id: host.id, label: host.label, target: host.target };
    const presence = await hostInstalled(host, discovery);

    if (!presence.installed) {
      reports.push({
        ...base,
        detectedVia: presence.via,
        installed: false,
        registration: "none",
        outcome: "not-installed",
      });
      continue;
    }

    const execBin = toolscanBin(host, discovery);
    const { registration, detail } = await host.inspect(execBin);
    const blocked = outcomeFor(registration, options.force === true);
    if (blocked) {
      reports.push({
        ...base,
        detectedVia: presence.via,
        installed: true,
        registration,
        outcome: blocked,
        note: noteFor(registration, detail),
      });
      continue;
    }

    if (options.dryRun) {
      reports.push({ ...base, detectedVia: presence.via, installed: true, registration, outcome: "would-register" });
      continue;
    }

    try {
      await host.register(execBin);
      reports.push({ ...base, detectedVia: presence.via, installed: true, registration, outcome: "registered" });
    } catch (error) {
      reports.push({
        ...base,
        detectedVia: presence.via,
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

/** What each registration means when nothing is being written. */
const DOCTOR_OUTCOME: Record<Registration, Outcome> = {
  ours: "already-registered",
  none: "not-registered",
  stale: "stale",
  other: "conflict",
  unknown: "conflict",
};

export async function runDoctor(
  options: { hosts?: McpHost[]; only?: string[]; discover?: () => Promise<ToolDiscovery> } = {},
): Promise<DoctorReport> {
  const hosts = selectHosts(options.hosts ?? createHosts(writeJsonConfig), options.only);
  const discovery = await (options.discover ?? discoverTools)();

  const reports: HostReport[] = [];
  for (const host of hosts) {
    const base = { id: host.id, label: host.label, target: host.target };
    const presence = await hostInstalled(host, discovery);
    if (!presence.installed) {
      reports.push({
        ...base,
        detectedVia: presence.via,
        installed: false,
        registration: "none",
        outcome: "not-installed",
      });
      continue;
    }
    const { registration, detail } = await host.inspect(toolscanBin(host, discovery));
    reports.push({
      ...base,
      detectedVia: presence.via,
      installed: true,
      registration,
      outcome: DOCTOR_OUTCOME[registration],
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
