import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
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
  | "stale" // ours, but the recorded launcher path is gone — re-register over it
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
  /**
   * Whether the host is present, when {@link bin} does not answer that.
   *
   * Cursor, VS Code and opencode are read and written through their config
   * files, so their shell commands are irrelevant to whether registration can
   * work — and `cursor`/`code` are opt-in shims a GUI user may never have
   * installed. Gating those hosts on PATH reported "not installed" for an
   * editor sitting right there and wrote nothing.
   */
  detectInstalled?(): Promise<boolean>;
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

/** How a host is told to reach `ix mcp`. */
export interface Launcher {
  command: string;
  args: string[];
}

/**
 * Characters an argument may contain and still be passed to cmd bare.
 *
 * A whitelist rather than a blacklist of whitespace and quotes: `&`, `^`, `|`,
 * `<` and `>` are all argument-splitting or escaping characters to cmd, and a
 * launcher path under `C:\Users\R&D\` contains no space, so a
 * "does it need quoting?" test that asks only about whitespace let it through
 * bare. Verified against a round-trip echo: `C:\Users\R&D\npm\ix.cmd` arrived
 * as `C:\Users\R`, with cmd then trying to run `D\npm\ix.cmd` as a second
 * command, and `C:\a^b\ix.cmd` arrived silently as `C:\ab\ix.cmd` — a wrong
 * launcher written into every host config and reported as a success.
 */
const SAFE_BARE_ARG = /^[A-Za-z0-9_@:.,=+\-\\/]+$/;

/**
 * Quote one argument for a Windows command line.
 *
 * Wrapping in double quotes is what makes a path containing a space — or a
 * `&`, or parentheses — survive: cmd treats a quoted region as literal. An
 * argument carrying a double quote of its own cannot be encoded this way and
 * is refused by {@link run}. Escaping it as `\"` satisfies the callee's own
 * argv parsing but flips cmd's quote tracking mid-argument, so a space later in
 * the same argument is then read as an argument separator. Verified against a
 * round-trip echo: every cmd encoding mangles such a value.
 */
export function quoteForCmd(arg: string): string {
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
      out += `${"\\".repeat(slashes)}\\"`;
      slashes = 0;
      continue;
    }
    slashes = 0;
    out += ch;
  }
  return `${out}${"\\".repeat(slashes)}"`;
}

/**
 * Invoke a host's own CLI.
 *
 * Windows cannot spawn these directly. npm ships them as `.cmd` shims, which
 * Node has refused to spawn without a shell since CVE-2024-27980 (`spawn
 * EINVAL`), while the bare name never resolves at all because CreateProcess
 * consults no PATHEXT. Both failures surfaced as ENOENT, which `inspect` read
 * as "cannot tell" and reported as a conflict — so on Windows every CLI-backed
 * host was left alone and nothing was ever registered.
 *
 * The Windows path therefore goes through cmd, as a single pre-quoted string.
 * Handing `shell: true` an args array instead lets Node concatenate them
 * unescaped (DEP0190), which loses any path containing a space.
 */
async function run(bin: string, args: string[]): Promise<RunResult> {
  const options = { encoding: "utf8" as const, timeout: HOST_CLI_TIMEOUT_MS, windowsHide: true };
  try {
    if (platform() === "win32") {
      // Refused rather than mangled: a half-parsed argument reaches the host as
      // several arguments and writes a corrupt entry. A double quote flips
      // cmd's quote tracking mid-argument, and `%` is expanded by cmd before
      // the quoting has any say — neither survives quoting, so neither is sent.
      const unencodable = [bin, ...args].find((arg) => arg.includes('"') || arg.includes("%"));
      if (unencodable !== undefined) {
        return { ok: false, stdout: "", stderr: `cannot pass this argument through cmd.exe: ${unencodable}` };
      }
      const line = [bin, ...args].map(quoteForCmd).join(" ");
      const { stdout, stderr } = await execFileAsync(line, { ...options, shell: true });
      return { ok: true, stdout, stderr };
    }
    const { stdout, stderr } = await execFileAsync(bin, args, options);
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
 * The command a host should launch to reach `ix mcp`.
 *
 * On Unix the bare name is right: it survives an upgrade that moves the
 * install. On Windows it is not — npm ships no `ix.exe`, only `ix.CMD`, and a
 * host spawning the bare name through CreateProcess never consults PATHEXT, so
 * it fails however well-formed the rest of the argv is. `ix-codex-plugin` hit
 * exactly this (its #13) and resolved the path itself; resolving it here keeps
 * that fix instead of handing the same problem to seven hosts. Falls back to
 * the bare name, which is no worse than not trying.
 */
let launcherProbe: Promise<Launcher> | undefined;

/** Memoised: `install` resolves this once per host it registers. */
function resolveLauncher(): Promise<Launcher> {
  return (launcherProbe ??= probeLauncher());
}

async function probeLauncher(): Promise<Launcher> {
  if (platform() !== "win32") return { command: "ix", args: ["mcp"] };

  const found = await run("where", ["ix"]);
  const entries = found.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  // `where` lists the exact-name match ahead of the PATHEXT variants, and npm's
  // exact-name entry is an extensionless `#!/bin/sh` shim — precisely the file
  // CreateProcess cannot launch. Taking the first line recorded that shim into
  // every host, so nothing started while `ix mcp doctor` still reported `+ ix on
  // PATH`. Only an entry Windows can actually execute counts.
  return { command: pickWindowsLauncher(entries) ?? "ix", args: ["mcp"] };
}

/** The first `where ix` entry Windows can actually execute. */
export function pickWindowsLauncher(entries: string[]): string | undefined {
  return entries.find(isWindowsExecutable);
}

function isWindowsExecutable(entry: string): boolean {
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const lower = entry.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Whether a path resolves today.
 *
 * Only ENOENT counts as absent — a permission error means something is there,
 * and reporting that as a dead launcher would rewrite a registration that is
 * fine.
 */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * The launcher a registration records, read from the parsed entry.
 *
 * Deliberately structural. Recovering the path by regex from the rendered text
 * cannot work: a Windows launcher normally sits under a username, and a path
 * containing a space is indistinguishable from two columns of a listing table.
 * The first attempt stopped at the space, so `C:\Users\Jane Doe\...\ix.cmd`
 * matched nothing and a dead launcher went on reading as healthy — the common
 * case, not the edge one. Worse, allowing a match to start at an interior `/`
 * made it latch onto a suffix like `/npm/ix.cmd` of a path that was perfectly
 * fine, report it stale, and silently rewrite a working registration.
 */
function launcherOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const command = (entry as { command?: unknown }).command;
  if (typeof command === "string") return command;
  // opencode records `command: ["ix", "mcp"]`.
  if (Array.isArray(command) && typeof command[0] === "string") return command[0];
  return null;
}

/** Absolute paths are the only ones whose disappearance we can check for. */
function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
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
 * A host saying, in its own words, that nothing holds the name.
 *
 * Some hosts report that by exiting non-zero, which is otherwise indistinguishable
 * from a host that could not answer at all.
 */
const MISSING_ENTRY = /\b(no (mcp )?server|not found|unknown server|does not exist|no such)\b/i;

/**
 * Decide what a host's own listing says about our name.
 *
 * Whether the matching line is ours is judged by whether it invokes the `ix`
 * binary — the bespoke integrations register this same name against
 * `python3 .../server.py` or `node dist/server.js`, and those must read as
 * `other` so they are reported rather than replaced.
 */
export function classifyListing(
  listing: string,
  recorded: string | null = null,
): Pick<HostStatus, "registration" | "detail"> {
  const matches = listing
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(SERVER_NAME));

  if (matches.length === 0) return { registration: "none" };

  // The listing is printed after any warm-up noise, so among the lines that are
  // not obviously diagnostics the last is the real row.
  const candidates = matches.filter((entry) => !LOG_LINE.test(entry));
  const line = candidates.at(-1) ?? matches[0]!;

  return judge(line, recorded);
}

/**
 * Classify a multi-line server definition.
 *
 * `openclaw mcp show` pretty-prints JSON, which puts `"command": "ix"` and
 * `"mcp"` on separate lines — line-at-a-time matching reads our own
 * registration as a stranger's and reports a false conflict on every re-run.
 */
export function classifyDefinition(blob: string): Pick<HostStatus, "registration" | "detail"> {
  return judge(blob.replace(/\s+/g, " ").trim(), launcherOf(parseEmbeddedObject(blob)));
}

/** The first JSON object in a blob, for hosts that pretty-print one. */
function parseEmbeddedObject(blob: string): unknown {
  const start = blob.indexOf("{");
  const end = blob.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(blob.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Classify what `<host> mcp show <name>` printed.
 *
 * Whether the host answered at all is part of the evidence, for the same reason
 * the listing path treats a failed `list` as occupied: guessing "none" is the
 * one wrong guess that overwrites something. A wedged config, a permissions
 * error, or an output format that changed upstream all fail the substring
 * checks below, and reading that as an empty slot replaced whatever the user
 * had — without `--force`, and reported as a cheerful `+ registered`. Only a
 * host that answered, or one that said outright it has no such server, may read
 * as free.
 */
export function classifyShown(blob: string, ok: boolean): Pick<HostStatus, "registration" | "detail"> {
  // "No MCP server named X" also mentions the name and also exits 0, so the
  // presence of a definition body is what distinguishes the two.
  const definition = blob.includes(SERVER_NAME) && blob.includes("{");
  if (definition) return classifyDefinition(blob);
  // Tied to our own name: "not found" and "no such" turn up in plenty of
  // unrelated failures (a missing plugin, the host's own loader), and reading
  // one of those as "the name is free" overwrites the user's server — the very
  // thing this function exists to prevent.
  if (!ok && !(MISSING_ENTRY.test(blob) && blob.includes(SERVER_NAME))) {
    return { registration: "unknown", detail: firstLine(blob) };
  }
  return { registration: "none" };
}

/** Ours iff the entry invokes the `ix` binary with the `mcp` subcommand. */
function judge(text: string, recorded: string | null): Pick<HostStatus, "registration" | "detail"> {
  if (!(/(^|[\s"'/\\])ix(\.\w+)?([\s"',\]]|$)/.test(text) && /\bmcp\b/.test(text))) {
    return { registration: "other", detail: truncate(text) };
  }

  // Windows records an absolute launcher path rather than the bare name, so the
  // entry dies whenever the npm prefix moves — an nvm switch, a reinstall
  // elsewhere. Judging that healthy from the command string alone is what made
  // `install` skip the one host it should have repaired, while `doctor` agreed
  // it was fine and no command anywhere would rewrite it.

  // A parsed entry gives the recorded command exactly, so it can be checked for
  // what it is: a path that has since disappeared.
  if (recorded !== null && isAbsolutePath(recorded) && !pathExists(recorded)) {
    return { registration: "stale", detail: `${recorded} no longer exists` };
  }

  // Hosts that answer with a rendered table give us no recorded command, and
  // staleness is not attempted for them. Five attempts at establishing it from
  // the row alone each produced the same class of failure — a *working*
  // registration reported stale, which re-registers with no `--force`. Parsing
  // the path back out broke on a different shape every time; comparing the row
  // against the launcher we would write today instead broke when `where`'s
  // console output was decoded as UTF-8 and a non-ASCII npm prefix came back
  // mangled, so a hand-repaired config was overwritten with an unstartable
  // path. The repair could not land on Claude Code anyway (see `register`).
  //
  // So this reports `ours`. A moved npm prefix on those hosts is not detected
  // and not repairable through `ix mcp install` at all — `--force` does not
  // apply to a registration already judged ours — so the user has to clear the
  // name with the host's own command (`claude mcp remove ix-memory`) and run
  // install again. That is a real gap, and a smaller one than silently
  // rewriting configs that were fine.
  return { registration: "ours", detail: truncate(text) };
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
  /** Built from the resolved launcher, so Windows gets the real path. */
  addArgs: (launcher: { command: string; args: string[] }) => string[];
  /**
   * Preferred over `listArgs` where the host can print one server's full
   * definition. A listing that shows only names cannot say whether the entry
   * is ours.
   */
  showArgs?: string[];
  /**
   * Used in place of `addArgs` on Windows, where an argument containing a
   * double quote cannot be encoded through cmd.
   */
  windowsFallback?: (launcher: { command: string; args: string[] }) => void;
}): McpHost {
  return {
    id: spec.id,
    label: spec.label,
    bin: spec.bin,
    target: spec.target,
    async inspect() {
      if (spec.showArgs) {
        const shown = await run(spec.bin, spec.showArgs);
        return classifyShown(`${shown.stdout}\n${shown.stderr}`, shown.ok);
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
      const launcher = await resolveLauncher();
      if (spec.windowsFallback && platform() === "win32") {
        spec.windowsFallback(launcher);
        return;
      }
      const result = await run(spec.bin, spec.addArgs(launcher));
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
export function stripJsonComments(raw: string): string {
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
function inspectJsonFile(path: string, ...keys: string[]): Pick<HostStatus, "registration" | "detail"> {
  const { value, missing } = readJsonFile(path);
  if (missing) return { registration: "none" };
  if (value === null) return { registration: "unknown", detail: `${path} is not valid JSON` };

  let servers: unknown = value;
  for (const key of keys) {
    if (typeof servers !== "object" || servers === null) return { registration: "none" };
    servers = (servers as Record<string, unknown>)[key];
  }
  if (typeof servers !== "object" || servers === null) return { registration: "none" };

  const entry = (servers as Record<string, unknown>)[SERVER_NAME];
  if (entry === undefined) return { registration: "none" };
  return classifyListing(`${SERVER_NAME} ${JSON.stringify(entry)}`, launcherOf(entry));
}

function vsCodeUserConfig(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  return join(home, ".config", "Code", "User", "mcp.json");
}

function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function openclawConfigPath(): string {
  return join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * A file-configured host counts as present if its shell command resolves *or*
 * its config directory exists.
 *
 * `cursor` and `code` are opt-in PATH shims — on macOS they appear only after
 * the user runs "Shell Command: Install 'code' command in PATH" — so their
 * absence says nothing about whether the editor is installed, and the config
 * file is what registration actually touches.
 */
function fileHostInstalled(bin: string, configPath: string): () => Promise<boolean> {
  return async () => (await isOnPath(bin)) || pathExists(dirname(configPath)) || pathExists(configPath);
}

/**
 * The argv each CLI-backed host is registered with.
 *
 * Exported so the flags stay pinned: `gemini mcp add` defaults to *project*
 * scope, and leaving that to the host default wrote `<cwd>/.gemini/settings.json`
 * while the report named the user-level file.
 */
export const ADD_ARGS = {
  claude: (ix: Launcher) => ["mcp", "add", "--scope", "user", SERVER_NAME, ix.command, ...ix.args],
  codex: (ix: Launcher) => ["mcp", "add", SERVER_NAME, "--", ix.command, ...ix.args],
  gemini: (ix: Launcher) => ["mcp", "add", "--scope", "user", SERVER_NAME, ix.command, ...ix.args],
  openclaw: (ix: Launcher) => [
    "mcp",
    "set",
    SERVER_NAME,
    JSON.stringify({ command: ix.command, args: ix.args }),
  ],
} satisfies Record<string, (ix: Launcher) => string[]>;

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
      addArgs: ADD_ARGS.claude,
    }),
    cliHost({
      id: "codex",
      label: "Codex CLI",
      bin: "codex",
      target: "~/.codex/config.toml",
      listArgs: ["mcp", "list"],
      addArgs: ADD_ARGS.codex,
    }),
    cliHost({
      id: "gemini",
      label: "Gemini CLI",
      bin: "gemini",
      target: "~/.gemini/settings.json",
      listArgs: ["mcp", "list"],
      addArgs: ADD_ARGS.gemini,
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
      addArgs: ADD_ARGS.openclaw,
      // `openclaw mcp set` takes its definition as a JSON argument, and a JSON
      // argument cannot be encoded through cmd (see `run`). Windows therefore
      // writes the documented config shape directly; every other platform keeps
      // going through the CLI so openclaw owns its own format.
      //
      // The *read* stays on `openclaw mcp show` on every platform, deliberately.
      // Its argv carries no quote and no `%`, so cmd handles it, and asking
      // openclaw whether it can see the entry is the only check that the shape
      // written here is one openclaw actually reads. Pairing the read with the
      // write would make a wrong key report `already registered` forever
      // instead of `not registered` — trading a loud failure for a silent one.
      windowsFallback: (ix) =>
        writeJson(openclawConfigPath(), (config) => {
          const mcp = (config.mcp ??= {}) as Record<string, unknown>;
          const servers = (mcp.servers ??= {}) as Record<string, unknown>;
          servers[SERVER_NAME] = { command: ix.command, args: ix.args };
        }),
    }),
    {
      id: "vscode",
      label: "VS Code",
      bin: "code",
      target: vsCodeUserConfig(),
      detectInstalled: fileHostInstalled("code", vsCodeUserConfig()),
      // No list subcommand, so the user-profile file is the only read path.
      async inspect() {
        return inspectJsonFile(vsCodeUserConfig(), "servers");
      },
      async register() {
        const ix = await resolveLauncher();
        // Written rather than handed to `code --add-mcp`, so the write lands in
        // the same file `inspect` reads. Shelling out needed `code` on PATH —
        // which a GUI-only install does not have — and passed a JSON argument,
        // which Windows cannot encode.
        writeJson(vsCodeUserConfig(), (config) => {
          const servers = (config.servers ??= {}) as Record<string, unknown>;
          servers[SERVER_NAME] = { command: ix.command, args: ix.args };
        });
      },
    },
    {
      id: "cursor",
      label: "Cursor",
      bin: "cursor",
      target: cursorConfigPath(),
      detectInstalled: fileHostInstalled("cursor", cursorConfigPath()),
      async inspect() {
        return inspectJsonFile(cursorConfigPath(), "mcpServers");
      },
      async register() {
        const ix = await resolveLauncher();
        writeJson(cursorConfigPath(), (config) => {
          const servers = (config.mcpServers ??= {}) as Record<string, unknown>;
          servers[SERVER_NAME] = { command: ix.command, args: ix.args };
        });
      },
    },
    {
      id: "opencode",
      label: "opencode",
      bin: "opencode",
      target: opencodeConfigPath(),
      detectInstalled: fileHostInstalled("opencode", opencodeConfigPath()),
      async inspect() {
        return inspectJsonFile(opencodeConfigPath(), "mcp");
      },
      async register() {
        const ix = await resolveLauncher();
        writeJson(opencodeConfigPath(), (config) => {
          const servers = (config.mcp ??= {}) as Record<string, unknown>;
          // Shape per https://opencode.ai/config.json — `type` and `command`
          // are required and the schema forbids extra properties.
          servers[SERVER_NAME] = { type: "local", command: [ix.command, ...ix.args], enabled: true };
        });
      },
    },
  ];
}
