#!/usr/bin/env node
/**
 * Harness registry reader for scripts/install-skill.sh.
 *
 * The skills table is explicit, small, and deliberate — a harness appears
 * here only once its skills directory has been verified against the harness's
 * actual convention (checked on a machine with every harness installed:
 * Cursor's skills live in `~/.cursor/skills-cursor`, and gemini, opencode,
 * openclaw and vscode have no skills convention at all, so they are not
 * install targets). This is *not* derived from the MCP host registry
 * (ix-cli/src/mcp/hosts.ts): that table answers "where does this harness read
 * its MCP config", which is a different question from "where does it load
 * skills" — deriving one from the other is a category error that produced
 * five install targets nothing reads. Adding a harness is a one-line edit
 * here, and a deliberate one, backed by having checked where that harness
 * actually looks.
 *
 * Output: one line per harness, `id|label|bin|config-dir|skill-dir`, with
 * `~` unexpanded (the shell expands it).
 *
 * `--probe` appends two more fields per line: `present` (`1`/`0`) and `via` —
 * the detection source that decided (toolscan | path | config-dir | none),
 * mirroring the CLI report's `detectedVia`. Presence: the bin is found (via
 * toolscan when TOOLSCAN_PATH is set, PATH otherwise) or the config directory
 * exists. The toolscan seam is optional and additive — TOOLSCAN_PATH is opt-in
 * (the helper never looks `toolscan` up on PATH) and when it is unset the
 * embedded PATH probe decides, so a clean machine behaves exactly as before
 * and CI never needs toolscan.
 *
 *   node scripts/skill-harnesses.mjs                  # the table
 *   node scripts/skill-harnesses.mjs --probe          # + presence + detection source per row
 *   HARNESS_HOME=P node scripts/skill-harnesses.mjs --probe  # where ~ resolves (hermetic tests)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * The installable harnesses and where each one reads skills.
 *
 * Verified per harness (2026-09-03, against a machine with all eight
 * candidates installed):
 *   claude  — ~/.claude/skills                         (correct)
 *   agents  — ~/.agents/skills                         (the agents.md surface)
 *   codex   — ~/.codex/skills                          (correct)
 *   cursor  — ~/.cursor/skills-cursor                  (NOT ~/.cursor/skills)
 * Deliberately absent: gemini/opencode/openclaw/vscode have no skills
 * convention (checked: ~/.gemini has extensions/commands only; ~/.config/
 * opencode has agents/commands/plugins; ~/.openclaw has agents/extensions/
 * flows; ~/.vscode has no skills concept and exists on every machine that
 * ever installed an extension — installing there would be inert, and probing
 * it would report a false positive).
 */
const SKILL_DIRS = {
  claude: { label: "Claude Code", bin: "claude", cfg: "~/.claude", skill: "~/.claude/skills" },
  agents: { label: "Agents (agents.md)", bin: "", cfg: "~/.agents", skill: "~/.agents/skills" },
  codex: { label: "Codex CLI", bin: "codex", cfg: "~/.codex", skill: "~/.codex/skills" },
  cursor: { label: "Cursor", bin: "cursor", cfg: "~/.cursor", skill: "~/.cursor/skills-cursor" },
};

/** A harness row as emitted by {@link readHarnesses} (cfg/skill `~`-unexpanded). */
export function readHarnesses() {
  return Object.entries(SKILL_DIRS).map(([id, entry]) => ({ id, ...entry }));
}

/** Whether a bare command resolves on PATH (the embedded fallback probe). */
export function binOnPath(bin) {
  if (!bin) return false;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the toolscan command: `TOOLSCAN_PATH` only.
 * Returns null when it is unset — the seam degrades, it never fails the
 * install, and it never executes a bare `toolscan` name from PATH (an
 * attacker-plantable name; opt-in only).
 */
export function resolveToolscan() {
  const explicit = process.env.TOOLSCAN_PATH?.trim();
  if (!explicit) return null;
  return /\.m?js$/i.test(explicit)
    ? { cmd: process.execPath, args: [explicit] }
    : { cmd: explicit, args: [] };
}

/**
 * Mirror of hosts.ts `quoteForCmd` for the shell branch below.
 *
 * Canonical copy: ix-cli/src/mcp/hosts.ts (the .mjs cannot import TS). The
 * two must stay byte-identical — the drift guard is skill-harnesses.test.ts,
 * which asserts this function equals the TS implementation across a battery
 * of arguments. Wrapping in double quotes is what makes a path containing a
 * space — or a `&`, or parentheses — survive: cmd treats a quoted region as
 * literal. An argument carrying a double quote of its own cannot be encoded
 * this way and is refused by hosts.ts `run`.
 */
const SAFE_BARE_ARG = /^[A-Za-z0-9_@:.,=+\-\\/]+$/;
export function quoteForCmd(arg) {
  if (SAFE_BARE_ARG.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      out += `${`\\`.repeat(slashes)}\\"`;
      slashes = 0;
      continue;
    }
    slashes = 0;
    out += ch;
  }
  return `${out}${`\\`.repeat(slashes)}"`;
}

/**
 * Run toolscan once and return the set of tool names it found with a usable
 * path (lowercased), or null when toolscan is unavailable or misbehaves.
 *
 * An entry that names a tool without a path is not usable evidence — mirror
 * the CLI's `hostInstalled`, which requires `discovery.paths` before it takes
 * the toolscan verdict — so name-only entries are ignored rather than
 * reported as a presence toolscan did not establish.
 */
export function runToolscanOnce(resolve = resolveToolscan) {
  const target = resolve();
  if (!target) return null;
  try {
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(target.cmd);
    // npm shims carry no executable bit and CreateProcess cannot launch them,
    // so the whole line goes through cmd, PRE-QUOTED (same as hosts.ts `run`
    // and discovery.ts `execSpawnable`): with `shell: true` and an args array
    // node joins them unquoted, so a shim path containing a space would be
    // split — the exact class hosts.ts::quoteForCmd exists for.
    const line = [target.cmd, ...target.args].map(quoteForCmd).join(" ");
    const out = execFileSync(useShell ? line : target.cmd, useShell ? {} : target.args, {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      ...(useShell ? { shell: true } : {}),
    });
    const parsed = JSON.parse(out);
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const names = new Set();
    for (const tool of tools) {
      if (
        typeof tool?.name === "string" &&
        tool.name !== "" &&
        typeof tool?.path === "string" &&
        tool.path !== ""
      ) {
        names.add(tool.name.toLowerCase());
      }
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Whether one harness is present, and which probe decided.
 *
 * Precedence mirrors the CLI's `detectedVia` (install.ts): toolscan first
 * (purely additive evidence — a harness its scan found is present no matter
 * what the embedded probes say), then the bin on PATH, then the config
 * directory (a GUI-only install is still found), else absent. `deps` injects
 * the probe functions so tests stay hermetic; the defaults are the real
 * implementations (toolscan output when present, `where`/`which`, and the
 * filesystem).
 */
export function probePresent(row, deps = {}) {
  const { toolscanNames = null, binOnPath: which = binOnPath, exists = existsSync } = deps;
  const binFound = toolscanNames ? toolscanNames.has(row.bin.toLowerCase()) : false;
  if (binFound) return { present: true, via: "toolscan" };
  if (which(row.bin)) return { present: true, via: "path" };
  // `~` resolves to the user's home — overridable through HARNESS_HOME so a
  // hermetic run can point it at an empty temp dir (install-skill.sh expands
  // `~` itself with $HOME for the destination paths; this override exists so
  // the presence decision agrees with that view on Windows, where node's
  // os.homedir() does not follow $HOME).
  const cfgExpanded = row.cfg.replace(/^~/, process.env.HARNESS_HOME || homedir());
  return exists(cfgExpanded) ? { present: true, via: "config-dir" } : { present: false, via: "none" };
}

export function main(argv = process.argv.slice(2)) {
  const probe = argv.includes("--probe");
  const rows = readHarnesses();

  const toolscanNames = probe ? runToolscanOnce() : null;
  const out = rows.map((row) => {
    const base = [row.id, row.label, row.bin, row.cfg, row.skill];
    if (!probe) return base.join("|");
    const { present, via } = probePresent(row, { toolscanNames });
    return [...base, present ? "1" : "0", via].join("|");
  });
  process.stdout.write(`${out.join("\n")}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
