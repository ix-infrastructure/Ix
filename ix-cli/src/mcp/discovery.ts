import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { quoteForCmd } from "./hosts.js";

const execFileAsync = promisify(execFile);

/**
 * Tool discovery seam for `ix mcp install` / `ix mcp doctor`.
 *
 * The embedded presence checks (hosts.ts's `detectInstalled` / `isOnPath`)
 * probe PATH only. toolscan (https://github.com/Alot1z/toolscan) scans PATH
 * *and* the common install roots beyond it — `~/.local/bin`, `~/.npm-global`,
 * `%LOCALAPPDATA%\Programs`, ... — which is exactly where a harness CLI ends
 * up when the user installed it outside their shell PATH. When toolscan is
 * available its discovery output feeds the presence decision; when it is not
 * (a clean machine, CI) the embedded checks decide, so nothing breaks and no
 * dependency is introduced. The relationship is a soft seam by design: Ix
 * stays zero-hard-dep, and toolscan is purely additive evidence.
 */
export interface ToolDiscovery {
  /** Where the tool list came from. */
  source: "toolscan" | "none";
  /** Tool names toolscan reported, lowercased (additive evidence only). */
  names: Set<string>;
  /** First reported path per name, for diagnostics. */
  paths: Map<string, string>;
}

/** The empty discovery: no toolscan, embedded checks decide. */
export const NO_DISCOVERY: ToolDiscovery = { source: "none", names: new Set(), paths: new Map() };

/** How long a toolscan scan may take before we give up on it. */
const TOOLSCAN_TIMEOUT_MS = 20_000;

/** A spawnable command line, as resolved from TOOLSCAN_PATH or PATH. */
interface Spawnable {
  cmd: string;
  args: string[];
}

/** Run a command on Windows through cmd when its shim needs it (.cmd/.bat). */
function execSpawnable(target: Spawnable): Promise<{ stdout: string }> {
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(target.cmd);
  const options = {
    encoding: "utf8" as const,
    timeout: TOOLSCAN_TIMEOUT_MS,
    windowsHide: true,
    ...(useShell ? { shell: true } : {}),
  };
  if (useShell) {
    // npm shims carry no executable bit and CreateProcess cannot launch them,
    // so the whole line goes through cmd, pre-quoted (same approach as
    // hosts.ts's `run` — an unquoted path containing a space would be split).
    return execFileAsync([target.cmd, ...target.args].map(quoteForCmd).join(" "), options);
  }
  return execFileAsync(target.cmd, target.args, options);
}

/**
 * Resolve the toolscan command: `TOOLSCAN_PATH` only, never a bare-name PATH
 * lookup.
 *
 * A PATH fallback would make `ix mcp install` execute *any* program named
 * `toolscan` that an attacker can plant on PATH, and let its JSON decide
 * which host config files get written — a widening this CLI deliberately
 * avoids (the same care as the bounded-read and symlink work). Opt-in only:
 * unset means no toolscan, and the embedded probes decide.
 */
export async function resolveToolscan(): Promise<Spawnable | null> {
  const explicit = process.env.TOOLSCAN_PATH?.trim();
  if (!explicit) return null;
  // A script path runs under node (that is how this repo invokes toolscan);
  // anything else is treated as an executable the user pointed at.
  return /\.m?js$/i.test(explicit)
    ? { cmd: process.execPath, args: [explicit] }
    : { cmd: explicit, args: [] };
}

/** Turn toolscan's JSON scan output into a name/path index. */
export function parseToolscanOutput(stdout: string): Pick<ToolDiscovery, "names" | "paths"> {
  const names = new Set<string>();
  const paths = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { names, paths };
  }
  const tools = (parsed as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return { names, paths };
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const tool = entry as { name?: unknown; path?: unknown };
    if (typeof tool.name !== "string" || tool.name === "") continue;
    const key = tool.name.toLowerCase();
    names.add(key);
    if (typeof tool.path === "string" && !paths.has(key)) paths.set(key, tool.path);
  }
  return { names, paths };
}

/**
 * Probe toolscan once and index what it found.
 *
 * Any failure — TOOLSCAN_PATH unset, unreadable, timed out, or emitting
 * something that is not the scan shape — degrades to the embedded checks
 * rather than failing the install. A broken optional seam must never break
 * the command it augments.
 */
export async function discoverTools(
  resolve: () => Promise<Spawnable | null> = resolveToolscan,
  parse: (stdout: string) => Pick<ToolDiscovery, "names" | "paths"> = parseToolscanOutput,
  run: (target: Spawnable) => Promise<{ stdout: string }> = execSpawnable,
): Promise<ToolDiscovery> {
  try {
    const target = await resolve();
    if (!target) return NO_DISCOVERY;
    const { stdout } = await run(target);
    const { names, paths } = parse(stdout);
    return names.size === 0 ? NO_DISCOVERY : { source: "toolscan", names, paths };
  } catch {
    return NO_DISCOVERY;
  }
}