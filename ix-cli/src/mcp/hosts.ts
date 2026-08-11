import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The name `ix mcp` registers itself under in every host. */
export const SERVER_NAME = "ix-memory";

/**
 * How long a host's own CLI gets to answer. `claude mcp list` health-checks
 * every configured server before printing, which measured ~1.8s here, so this
 * is generous enough for the slowest of them without hanging `ix mcp doctor`
 * on a host that is wedged.
 */
const HOST_CLI_TIMEOUT_MS = 20_000;

/** What a host currently has registered under {@link SERVER_NAME}. */
export type Registration =
  | "none" // nothing under our name; safe to add
  | "ours" // already points at `ix mcp`; nothing to do
  | "other" // a different server holds the name — never overwrite without --force
  | "unknown"; // could not tell, so treat it as occupied

export interface HostStatus {
  id: string;
  label: string;
  installed: boolean;
  registration: Registration;
  /** What was found, for the human-readable report. */
  detail?: string;
}

export interface McpHost {
  id: string;
  label: string;
  /** Executable whose presence on PATH means the host is installed. */
  bin: string;
  /** Read-only look at what holds {@link SERVER_NAME} today. */
  inspect(): Promise<Pick<HostStatus, "registration" | "detail">>;
  /** Register `ix mcp`. Only called once inspect reports it is safe. */
  register(): Promise<void>;
  /** Where the registration lands, shown in the report. */
  target: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(bin: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: "utf8",
      timeout: HOST_CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}

export async function isOnPath(bin: string): Promise<boolean> {
  const probe = platform() === "win32" ? "where" : "which";
  return (await run(probe, [bin])).ok;
}

/**
 * Lines that mention a server name only because something went wrong.
 *
 * Gemini writes its whole listing to stderr behind ~28 lines of extension
 * loader errors, several of which name the extension — and the extension here
 * is itself called `ix-memory`. Matching one of those instead of the listing
 * row reports a diagnostic as though it were the registration.
 */
const LOG_LINE = /^\[|^\s*(error|warning|warn|failed|validation)\b|Error:|Failed to|Validation failed/i;

/**
 * Decide what a host's own listing says about our name.
 *
 * Whether the matching line is ours is judged by whether it invokes the `ix`
 * binary — the bespoke integrations register this same name against
 * `python3 .../server.py` or `node dist/server.js`, and those must read as
 * `other` so they are reported rather than replaced.
 */
export function classifyListing(listing: string): Pick<HostStatus, "registration" | "detail"> {
  const matches = listing
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(SERVER_NAME));

  if (matches.length === 0) return { registration: "none" };

  // The listing is printed after any warm-up noise, so among the lines that are
  // not obviously diagnostics the last is the real row.
  const candidates = matches.filter((entry) => !LOG_LINE.test(entry));
  const line = candidates.at(-1) ?? matches[0]!;

  return judge(line);
}

/**
 * Classify a multi-line server definition.
 *
 * `openclaw mcp show` pretty-prints JSON, which puts `"command": "ix"` and
 * `"mcp"` on separate lines — line-at-a-time matching reads our own
 * registration as a stranger's and reports a false conflict on every re-run.
 */
export function classifyDefinition(blob: string): Pick<HostStatus, "registration" | "detail"> {
  return judge(blob.replace(/\s+/g, " ").trim());
}

/** Ours iff the entry invokes the `ix` binary with the `mcp` subcommand. */
function judge(text: string): Pick<HostStatus, "registration" | "detail"> {
  if (/(^|[\s"'/\\])ix(\.\w+)?([\s"',\]]|$)/.test(text) && /\bmcp\b/.test(text)) {
    return { registration: "ours", detail: truncate(text) };
  }
  return { registration: "other", detail: truncate(text) };
}

function truncate(line: string, max = 120): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A host that answers both questions through its own CLI. */
function cliHost(spec: {
  id: string;
  label: string;
  bin: string;
  target: string;
  listArgs: string[];
  addArgs: string[];
  /**
   * Preferred over `listArgs` where the host can print one server's full
   * definition. A listing that shows only names cannot say whether the entry
   * is ours.
   */
  showArgs?: string[];
}): McpHost {
  return {
    id: spec.id,
    label: spec.label,
    bin: spec.bin,
    target: spec.target,
    async inspect() {
      if (spec.showArgs) {
        const shown = await run(spec.bin, spec.showArgs);
        const blob = `${shown.stdout}\n${shown.stderr}`;
        // "No MCP server named X" also mentions the name and also exits 0, so
        // presence of a definition body is what distinguishes the two.
        if (!blob.includes(SERVER_NAME) || !blob.includes("{")) return { registration: "none" };
        return classifyDefinition(blob);
      }

      const result = await run(spec.bin, spec.listArgs);
      // A host that cannot answer is treated as occupied rather than empty:
      // guessing "none" here is the one wrong guess that overwrites something.
      if (!result.ok && !result.stdout.includes(SERVER_NAME)) {
        return { registration: "unknown", detail: firstLine(result.stderr) };
      }
      return classifyListing(`${result.stdout}\n${result.stderr}`);
    },
    async register() {
      const result = await run(spec.bin, spec.addArgs);
      if (!result.ok) {
        throw new Error(firstLine(result.stderr) || firstLine(result.stdout) || "registration failed");
      }
    },
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]?.trim() ?? "";
}

function readJsonFile(path: string): { value: Record<string, unknown> | null; missing: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { value: null, missing: true };
  }
  // VS Code ships this file as zero bytes until something writes it, and an
  // empty file is not parseable JSON.
  if (raw.trim() === "") return { value: {}, missing: false };
  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    return { value: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}, missing: false };
  } catch {
    return { value: null, missing: false };
  }
}

/**
 * Strip `//` and block comments.
 *
 * VS Code and Cursor both accept JSON-with-comments in these files, and a user
 * who has hand-annotated theirs must not read as corrupt.
 */
function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 1; } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out;
}

/** Inspect a host by reading the JSON file its servers live in. */
function inspectJsonFile(path: string, key: string): Pick<HostStatus, "registration" | "detail"> {
  const { value, missing } = readJsonFile(path);
  if (missing) return { registration: "none" };
  if (value === null) return { registration: "unknown", detail: `${path} is not valid JSON` };

  const servers = value[key];
  if (typeof servers !== "object" || servers === null) return { registration: "none" };

  const entry = (servers as Record<string, unknown>)[SERVER_NAME];
  if (entry === undefined) return { registration: "none" };
  return classifyListing(`${SERVER_NAME} ${JSON.stringify(entry)}`);
}

function vsCodeUserConfig(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  return join(home, ".config", "Code", "User", "mcp.json");
}

export function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * The hosts `ix mcp install` knows about.
 *
 * Writes go through each host's own CLI wherever one exists, so the host owns
 * its config format and a format change upstream cannot corrupt a file here.
 * Only Cursor (no MCP CLI) and opencode (`opencode mcp add` is interactive and
 * takes no arguments) are written directly, and both are plain JSON.
 */
export function createHosts(writeJson: (path: string, mutate: (config: Record<string, unknown>) => void) => void): McpHost[] {
  return [
    cliHost({
      id: "claude",
      label: "Claude Code",
      bin: "claude",
      target: "user scope",
      listArgs: ["mcp", "list"],
      addArgs: ["mcp", "add", "--scope", "user", SERVER_NAME, "ix", "mcp"],
    }),
    cliHost({
      id: "codex",
      label: "Codex CLI",
      bin: "codex",
      target: "~/.codex/config.toml",
      listArgs: ["mcp", "list"],
      addArgs: ["mcp", "add", SERVER_NAME, "--", "ix", "mcp"],
    }),
    cliHost({
      id: "gemini",
      label: "Gemini CLI",
      bin: "gemini",
      target: "~/.gemini/settings.json",
      listArgs: ["mcp", "list"],
      addArgs: ["mcp", "add", SERVER_NAME, "ix", "mcp"],
    }),
    cliHost({
      id: "openclaw",
      label: "OpenClaw",
      bin: "openclaw",
      target: "~/.openclaw/openclaw.json",
      listArgs: ["mcp", "list"],
      // `openclaw mcp list` prints names only ("- ix-memory"), so the command
      // behind the name is invisible there.
      showArgs: ["mcp", "show", SERVER_NAME],
      addArgs: ["mcp", "set", SERVER_NAME, JSON.stringify({ command: "ix", args: ["mcp"] })],
    }),
    {
      id: "vscode",
      label: "VS Code",
      bin: "code",
      target: vsCodeUserConfig(),
      // No list subcommand, so the user-profile file is the only read path.
      async inspect() {
        return inspectJsonFile(vsCodeUserConfig(), "servers");
      },
      async register() {
        const definition = JSON.stringify({ name: SERVER_NAME, command: "ix", args: ["mcp"] });
        const result = await run("code", ["--add-mcp", definition]);
        if (!result.ok) throw new Error(firstLine(result.stderr) || "code --add-mcp failed");
      },
    },
    {
      id: "cursor",
      label: "Cursor",
      bin: "cursor",
      target: cursorConfigPath(),
      async inspect() {
        return inspectJsonFile(cursorConfigPath(), "mcpServers");
      },
      async register() {
        writeJson(cursorConfigPath(), (config) => {
          const servers = (config.mcpServers ??= {}) as Record<string, unknown>;
          servers[SERVER_NAME] = { command: "ix", args: ["mcp"] };
        });
      },
    },
    {
      id: "opencode",
      label: "opencode",
      bin: "opencode",
      target: opencodeConfigPath(),
      async inspect() {
        return inspectJsonFile(opencodeConfigPath(), "mcp");
      },
      async register() {
        writeJson(opencodeConfigPath(), (config) => {
          const servers = (config.mcp ??= {}) as Record<string, unknown>;
          // Shape per https://opencode.ai/config.json — `type` and `command`
          // are required and the schema forbids extra properties.
          servers[SERVER_NAME] = { type: "local", command: ["ix", "mcp"], enabled: true };
        });
      },
    },
  ];
}
