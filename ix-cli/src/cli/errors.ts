// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { CommanderError, type Command } from "commander";
import { PRE_CONNECTION_CODES, RESET_RECONCILIATION_ERROR } from "../client/transport.js";

import { DEFAULT_ENDPOINT, isLoopbackEndpoint, isManagedLocalBackend } from "./endpoint.js";
import { llmError } from "./llm.js";
import { exitCodeFor } from "./outcome.js";
import { BUILT_IN_DEFAULT_FORMAT, resolveDefaultFormat } from "./default-format.js";

// ── Answering in the format the caller asked for ───────────────────────────

/**
 * The format this run answers in, once it is known, or undefined while it is
 * still the configured default.
 *
 * A failure is the one answer an agent is least equipped to guess at, and it
 * was the only one this CLI would not give in the format it had been asked
 * for: a backend that is down produced several lines of coloured prose on
 * stderr and nothing at all on stdout, so a caller parsing records saw an
 * empty stream and a non-zero exit with no reason attached.
 */
let requestedFormat: string | undefined;

/** Where the format comes from before a command has been parsed. */
let formatFallback: (() => string | undefined) | undefined;
let fallbackFormat: { value: string | undefined } | undefined;

/**
 * Record the format for the error boundary. `run-cli.ts` calls it with the
 * parsed command's own `--format` value as soon as commander has one, so a
 * failure is answered in exactly the format the payload would have been.
 */
export function setErrorFormat(format: string | undefined): void {
  requestedFormat = format;
}

/**
 * How to find the format when nothing has been recorded yet: an error thrown
 * while the commands are being registered, or a usage error commander raises
 * while parsing. Resolved only if such an error is rendered, so a run that
 * succeeds never pays for it, and resolved at most once.
 */
export function setErrorFormatFallback(resolve: (() => string | undefined) | undefined): void {
  formatFallback = resolve;
  fallbackFormat = undefined;
}

/** The format a failure is answered in right now. Never throws. */
export function errorFormat(): string | undefined {
  if (requestedFormat !== undefined) return requestedFormat;
  if (!formatFallback) return undefined;
  if (!fallbackFormat) {
    let value: string | undefined;
    try { value = formatFallback(); } catch { value = undefined; }
    fallbackFormat = { value };
  }
  return fallbackFormat.value;
}

/**
 * True when the record on stdout replaces the prose on stderr rather than
 * accompanying it. Only llm: it is read whole into an agent's context, where
 * the same failure twice is noise. json keeps the prose on stderr as text does,
 * because callers already read their error guidance from there (the plugin
 * runners build their message from stderr, and log failures that have it).
 */
function recordReplacesProse(format: string | undefined): boolean {
  return format === "llm";
}

/**
 * The `--format` the caller typed, read straight off argv.
 *
 * Read from argv rather than from the parsed command because this has to work
 * before commander has parsed anything: the handler that calls
 * `renderCliError` is installed for `unhandledRejection` and
 * `uncaughtException`, which can fire at any point, including during
 * registration.
 *
 * Stops at `--`, so a term that merely looks like a flag —
 * `ix text -- "--format llm"` — is not read as one.
 */
export function detectRequestedFormat(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") return undefined;
    if (arg.startsWith("--format=")) return arg.slice("--format=".length);
    if (arg === "--format") return argv[i + 1];
  }
  return undefined;
}

/**
 * The format to answer a failure in before a command has been parsed, resolved
 * the way a command's default `--format` is: the flag that was typed, then
 * `IX_FORMAT`, then `format` in config.yaml, then text.
 *
 * `readConfigFormat` is guarded: this runs inside the error boundary, which
 * must never throw, and a config.yaml that does not parse is the very failure
 * it may be in the middle of reporting.
 */
export function resolveErrorFormat(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  readConfigFormat: () => string | undefined,
): string {
  const typed = detectRequestedFormat(argv);
  if (typed !== undefined) return typed;
  return resolveDefaultFormat(env, () => {
    try { return readConfigFormat(); } catch { return undefined; }
  }).format;
}

/**
 * The format a parsed command answers in: its own `--format` value, which
 * commander has already resolved from the flag or the configured default. A
 * command with no `--format` prints prose, so its failures do too.
 */
export function commandFormat(command: Command): string {
  const value = declaresFormat(command) ? command.opts().format : undefined;
  return typeof value === "string" ? value : BUILT_IN_DEFAULT_FORMAT;
}

function declaresFormat(command: Command): boolean {
  return command.options.some((option) => option.long === "--format");
}

/**
 * The format a usage error commander raises on `command` is answered in.
 *
 * Only a command that takes `--format` answers in records: `ix hook --bogus`
 * or `ix mcp serve --bogus` under IX_FORMAT=json is still prose on stderr, as
 * every other failure of those commands is. For one that does, the typed flag
 * is read off argv first, because commander may raise the error before it has
 * reached `--format` (a bad value for an earlier option); otherwise it is the
 * command's own resolved default.
 */
export function usageErrorFormat(command: Command, argv: readonly string[]): string {
  if (!declaresFormat(command)) return BUILT_IN_DEFAULT_FORMAT;
  return detectRequestedFormat(argv) ?? commandFormat(command);
}

/**
 * Emit the failure as one record on stdout when the format is json or llm.
 * Returns true when that record is the whole report (llm), so the caller skips
 * its prose; false when the caller still writes the prose to stderr (text, and
 * json, where stdout carries the one record and stderr keeps the prose).
 *
 * On stdout: stdout is where the answer goes, and "there is no answer, because
 * X" is an answer.
 *
 * One shape per format, whatever failed: `error code=… message=… hint=…` for
 * llm, and `{"error": code, "message": …, "next": …}` for json, with any extra
 * fields between the message and the next step.
 *
 * Exported for the commands that catch a failure themselves (`ix status`,
 * `ix verify`), so their record is this one; they pass their own `--format`.
 */
export function emitErrorRecord(
  code: string,
  message: string,
  hint?: string,
  extra: Array<[string, string]> = [],
  format: string | undefined = errorFormat(),
): boolean {
  if (format === "json") {
    console.log(JSON.stringify({
      error: code,
      message,
      ...Object.fromEntries(extra),
      ...(hint ? { next: hint } : {}),
    }));
  } else if (format === "llm") {
    console.log(llmError(code, message, [...extra, ...(hint ? [["hint", hint] as [string, string]] : [])]));
  }
  return recordReplacesProse(format);
}

// ── Commander's own failures ───────────────────────────────────────────────

/** Commander's exits that are answers, not failures. */
const COMMANDER_SUCCESS_CODES = new Set(["commander.helpDisplayed", "commander.help", "commander.version"]);

/**
 * The format each commander exit was raised in, keyed by the error. Its
 * presence also means commander has already written its own message to
 * stderr unless that format is llm.
 */
const commanderFormats = new WeakMap<object, string | undefined>();

/**
 * The `exitOverride` callback for the CLI's commands: throw commander's exit as
 * an error so `renderCliError` can answer it in the caller's format.
 * `bindCommanderErrors` passes the format for the command that raised it;
 * without one, it is the run's.
 *
 * `executeSubCommandAsync` is commander's own exception, as in its default
 * override: it reports a spawned child, and there is nothing to throw to.
 */
export function throwCommanderExit(err: CommanderError, format: string | undefined = errorFormat()): void {
  if (err.code === "commander.executeSubCommandAsync") return;
  commanderFormats.set(err, format);
  throw err;
}

/**
 * Commander's `outputError`: its own message on stderr, unless the format is
 * llm, in which case `renderCliError` prints the one report on stdout.
 */
export function writeCommanderError(
  str: string,
  write: (str: string) => void,
  format: string | undefined = errorFormat(),
): void {
  if (!recordReplacesProse(format)) write(str);
}

/**
 * Point every command's commander exits at the boundary, each with its own
 * format (`usageErrorFormat`). Run once every command is registered and before
 * parsing; a command added later keeps the inherited, run-wide handlers.
 */
export function bindCommanderErrors(root: Command, argv: readonly string[]): void {
  const visit = (command: Command): void => {
    const format = () => usageErrorFormat(command, argv);
    command.exitOverride((err) => throwCommanderExit(err, format()));
    command.configureOutput({ outputError: (str, write) => writeCommanderError(str, write, format()) });
    for (const sub of command.commands) visit(sub);
  };
  visit(root);
}

/**
 * Structured error with user-facing message and optional next-step guidance.
 * Parsed from backend JSON responses that include `error`, `message`, and `next` fields.
 */
export interface StructuredError {
  error: string;
  message: string;
  next?: string;
}

/**
 * Attempt to parse a structured error from a backend HTTP error message.
 * Backend errors arrive as "${status}: ${jsonBody}" from the API client.
 */
export function parseBackendError(errMessage: string): StructuredError | null {
  // Match "NNN: {json}" pattern from api.ts error throwing
  const match = errMessage.match(/^(\d{3}):\s*(.+)$/s);
  if (!match) return null;

  try {
    const body = JSON.parse(match[2]);
    if (body.error && body.message) {
      return {
        error: body.error,
        message: body.message,
        next: body.next ?? undefined,
      };
    }
  } catch {
    // Not valid JSON — fall through
  }
  return null;
}

/**
 * Render a structured error to stderr with clean formatting.
 * No stack traces, no internal jargon.
 */
export function renderStructuredError(err: StructuredError): void {
  console.error("");
  console.error(chalk.red(`  ${err.message}`));
  if (err.next) {
    console.error("");
    console.error(chalk.dim("  Next"));
    console.error(`  ${err.next}`);
  }
  console.error("");
}

export class CliUsageError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliResolutionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "CliResolutionError";
  }
}

/**
 * A graph read was asked for from a directory no registered workspace covers.
 *
 * This used to be answered anyway: the read fell back to whichever workspace
 * carried `default: true` -- an unrelated repository -- or, with no default,
 * ran unscoped across every workspace on the backend, which is how one
 * function came back as four rows from four checkouts of the same repo. Both
 * look like answers. Refusing, and saying how to map the directory, is the
 * only response that cannot be mistaken for one.
 *
 * Its `message` stands alone, because `ix mcp` runs commands in-process and
 * relays a thrown error's message as-is rather than through the renderer below.
 */
export class WorkspaceNotMappedError extends Error {
  readonly code = "workspace_not_mapped";
  constructor(
    public readonly dir: string,
    public readonly hint: string = workspaceNotMappedHint(dir),
  ) {
    super(`workspace_not_mapped: ${dir} is not inside a mapped Ix workspace, so there is no graph to answer from. ${hint}`);
    this.name = "WorkspaceNotMappedError";
  }
  /** The message without the code prefix or the hint, for renderers that carry both separately. */
  get summary(): string {
    return `${this.dir} is not inside a mapped Ix workspace, so there is no graph to answer from.`;
  }
}

/**
 * How to get a graph for `dir`. `ix map` with no argument maps the enclosing
 * git repository (see `resolveMapRoot`), so that is named when there is one;
 * outside a repository a bare `ix map` would fall back to the configured
 * default workspace, so the path is spelled out instead.
 */
export function workspaceNotMappedHint(dir: string, gitRoot?: string): string {
  const map = gitRoot
    ? `Run \`ix map\` here to map ${gitRoot}`
    : `Run \`ix map ${dir}\` to map this directory`;
  return `${map}, or run the command from inside a workspace that is already mapped (\`ix config show\` lists them).`;
}

/**
 * Format an error for display, unwrapping fetch `TypeError: fetch failed`
 * to expose the underlying transport cause (e.g. ECONNRESET, UND_ERR_SOCKET).
 *
 * Node's built-in fetch (undici) throws `TypeError('fetch failed')` on any
 * transport-level failure and stashes the real error in `err.cause`. Without
 * this unwrap, users see a bare "fetch failed" with no actionable detail —
 * see the Node 18 EOL / undici 5.x transport-drop bug report.
 */
export function formatFetchError(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  const e = err as { message?: unknown; cause?: unknown };
  const base = typeof e.message === "string" && e.message.length > 0
    ? e.message
    : String(err);

  // "terminated" is what undici reports when a connection dies after the
  // response headers — the commonest mid-flight shape, and one that carries no
  // detail at all without this unwrap.
  const lower = base.toLowerCase();
  if ((lower.includes("fetch failed") || lower.includes("terminated")) && e.cause) {
    const cause = e.cause as { code?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof cause.code === "string" && cause.code.length > 0) {
      parts.push(cause.code);
    }
    if (typeof cause.message === "string" && cause.message.length > 0) {
      parts.push(cause.message);
    } else if (parts.length === 0) {
      parts.push(String(e.cause));
    }
    return `${base} (${parts.join(": ")})`;
  }

  return base;
}

/**
 * Transport-level codes meaning "we did not get a working backend on the other
 * end", as opposed to the backend answering with an error. Node's fetch
 * surfaces these as `TypeError: fetch failed` with the real error under `cause`.
 *
 * `UND_ERR_SOCKET` ("other side closed") belongs here despite describing an
 * established socket: measured, it is what you get from a port that accepts and
 * then closes without answering — a container that is still booting, a dead
 * container behind a published port, a port-forward to nothing. That user does
 * need "start the backend, then check status".
 *
 * `ECONNRESET` and `ETIMEDOUT` are deliberately absent. Those are a connection
 * that was working and then died, which is a different problem with a different
 * remedy; they fall through to the generic path, which names the cause. The
 * connect-phase half of `ETIMEDOUT` does not need special handling: undici's
 * 10s connect timeout fires first and reports `UND_ERR_CONNECT_TIMEOUT`, which
 * is already listed here.
 */
// The pre-connection codes are shared with the HTTP client, which needs the
// same "nothing was transmitted" judgement to decide whether a failed reset
// could have deleted anything. One definition, not two: a second hand-written
// copy is how the two drift apart. `UND_ERR_SOCKET` is added only here — see
// above for why it counts as unreachable for rendering but not for reset.
const UNREACHABLE_CODES = new Set([...PRE_CONNECTION_CODES, "UND_ERR_SOCKET"]);

function isUnreachableCode(e: { code?: unknown } | null | undefined): boolean {
  return typeof e?.code === "string" && UNREACHABLE_CODES.has(e.code);
}

/** An unresolved endpoint means the default local install. */
const orDefault = (endpoint?: string): string => endpoint || DEFAULT_ENDPOINT;

/**
 * Under IX_DEBUG, print the error *and its cause chain*.
 *
 * `err.stack` alone is empty for the very case this module exists to handle:
 * Node's fetch rejects with a `TypeError: fetch failed` whose frames are lost
 * across the async boundary, so the whole diagnostic — ECONNREFUSED vs
 * ENOTFOUND vs a TLS failure — lives in `err.cause`. Printing only the stack
 * meant `IX_DEBUG=1` emitted one useless line for a backend-down error.
 *
 * Walks the chain by hand rather than handing the error to `util.inspect`.
 * This is the process-wide error boundary, and inspect prints every own
 * property of whatever was thrown; Pro holds a tunnel JWT and a long-lived
 * refresh token, so the day something throws an error carrying its own request
 * we would print credentials into output the user is about to paste into an
 * issue. Only stack, message and code are ever emitted.
 */
function writeDebugDetail(err: unknown): void {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;

  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { stack?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    const body =
      typeof e.stack === "string" && e.stack.length > 0
        ? `${code}${e.stack}`
        : `${code}${typeof e.message === "string" ? e.message : String(cur)}`;
    lines.push(lines.length === 0 ? body : `  [cause] ${body}`);
    cur = typeof cur === "object" ? e.cause : undefined;
  }

  process.stderr.write(chalk.dim(`${lines.length > 0 ? lines.join("\n") : String(err)}\n`));
}

/**
 * True when the error is a failure to reach the backend at all. This is by far
 * the most common failure for a fresh install — the CLI is on PATH but the
 * Docker backend was never started — so it gets its own actionable message
 * instead of an undici stack trace.
 */
export function isBackendUnreachable(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  // An error that carries its own instruction must not be re-explained by its
  // cause. Reset attaches the transport failure for IX_DEBUG, which would
  // otherwise render "start the backend, then check status" on top of a
  // "do not repeat this reset" warning — advising the retry it exists to stop.
  if (e?.name === RESET_RECONCILIATION_ERROR) return false;
  if (isUnreachableCode(e)) return true;
  return isUnreachableCode(e?.cause as { code?: unknown } | null | undefined);
}

/**
 * The one description of a backend nobody answered at.
 *
 * Shared so a command that catches the failure itself — `ix status` does, to
 * keep its own shape — reports the same code, the same sentence and the same
 * next step as the process-wide boundary. It was two wordings before, one of
 * them with no next step at all.
 */
export function backendUnreachableError(endpoint?: string): StructuredError {
  return {
    error: "backend_unreachable",
    message: `Ix backend not reachable${endpoint ? ` at ${endpoint}` : ""}.`,
    // `ix docker start` only fixes a backend this machine is supposed to run.
    // Pro points `config.endpoint` at a cloud instance, where that advice is
    // both useless and actively wrong — it starts a backend you aren't using.
    // A loopback backend on another port is not one either: that command
    // starts the standalone compose on the default port, not this one.
    next: isManagedLocalBackend(orDefault(endpoint))
      ? "Start it with `ix docker start`, then check `ix status`."
      : "Check your network, and that the endpoint is right (`ix config get endpoint`).",
  };
}

/**
 * config.yaml does not parse. Every command reads it, so every command stops
 * here, naming the file rather than quietly running on defaults.
 */
export function configParseError(path: string, detail: string): StructuredError {
  return {
    error: "config_parse_error",
    message: `${path} is not valid YAML, so Ix will not run on a guess: ${detail}`,
    next: `Fix the file, or move it aside to start from defaults (your workspace registrations are in it): mv ${path} ${path}.broken`,
  };
}

/**
 * config.yaml could not be locked for a write. Nothing was written: Ix never
 * writes the file unlocked, because that is how parallel registrations lost
 * each other's workspaces.
 */
export function configLockError(detail: string): StructuredError {
  return {
    error: "config_lock_timeout",
    message: `Ix could not lock its config to write it: ${detail}`,
    next: "Wait for the other ix command to finish and run this one again.",
  };
}

/**
 * A backend response of the wrong shape (`BackendContractError`): `message` is
 * its own, which names the route and the field.
 */
export function backendContractError(message: string, endpoint?: string): StructuredError {
  return {
    error: "backend_contract_error",
    message: message.replace(/^backend_contract_error:\s*/, `The Ix backend${endpoint ? ` at ${endpoint}` : ""} answered in a shape this CLI does not read: `),
    next: "The backend and this CLI probably come from different releases. Run `ix doctor` to check the backend; `ix upgrade` updates the CLI and a local backend.",
  };
}

/**
 * The backend answered 401 `local_token_required`: it was started with
 * IX_LOCAL_TOKEN and this CLI sent no token, or a different one.
 */
export function localTokenRequiredError(endpoint?: string): StructuredError {
  return {
    error: "local_token_required",
    message: `The Ix backend${endpoint ? ` at ${endpoint}` : ""} requires a token this CLI did not send or that it refused.`,
    next: isManagedLocalBackend(orDefault(endpoint))
      ? "Run `ix docker start --local-token` to give the backend this CLI's stored token, or set IX_TOKEN to the backend's token."
      : isLoopbackEndpoint(orDefault(endpoint))
        ? // The token IS sent here, but `ix docker start` would start a different backend.
          "Set IX_TOKEN to that backend's token."
        : "This CLI sends its token (IX_TOKEN or the stored one) only to a backend on this machine. " +
          "Reach that backend through a local port forward (for example `ssh -L 8090:localhost:8090 <host>`) " +
          `and point IX_ENDPOINT at ${DEFAULT_ENDPOINT}.`,
  };
}

export function renderCliError(err: unknown, debug = false, endpoint?: string): void {
  // Commander's usage errors (unknown option, bad value, missing argument), and
  // its help and version exits, which are successes and keep their exit code.
  // Commander has already printed its own message unless the caller asked for
  // records; an InvalidArgumentError thrown by our own validation has not.
  if (err instanceof CommanderError) {
    if (err.exitCode !== 0 && !COMMANDER_SUCCESS_CODES.has(err.code)) {
      const message = err.message.replace(/^error:\s*/i, "");
      const raised = commanderFormats.has(err);
      const format = raised ? commanderFormats.get(err) : errorFormat();
      // Raised through commander's exit, it has written its message already.
      if (!emitErrorRecord("usage_error", message, undefined, [], format) && !raised) {
        process.stderr.write(chalk.red(`Error: ${message}\n`));
      }
      if (debug) writeDebugDetail(err);
    }
    process.exit(err.exitCode);
  }

  if (err instanceof CliUsageError || err instanceof CliResolutionError) {
    const code = err instanceof CliUsageError ? "usage_error" : "resolution_failed";
    if (!emitErrorRecord(code, err.message, err.hint)) {
      process.stderr.write(chalk.red(`Error: ${err.message}\n`));
      if (err.hint) {
        process.stderr.write(chalk.dim(`${err.hint}\n`));
      }
    }
    if (debug && err instanceof CliResolutionError && err.detail) {
      process.stderr.write(chalk.dim(`Detail: ${err.detail}\n`));
    }
    process.exit(1);
  }

  if (err instanceof WorkspaceNotMappedError) {
    if (!emitErrorRecord(err.code, err.summary, err.hint, [["dir", err.dir]])) {
      renderStructuredError({ error: err.code, message: err.summary, next: err.hint });
    }
    // Its own code, so an agent knows to map rather than retry (outcome.ts).
    process.exit(exitCodeFor("not_mapped"));
  }

  const e = err as any;

  if (isBackendUnreachable(err)) {
    const unreachable = backendUnreachableError(endpoint);
    if (!emitErrorRecord(unreachable.error, unreachable.message, unreachable.next)) {
      renderStructuredError(unreachable);
    }
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  if (e?.name === "ConfigParseError") {
    const broken = configParseError(e.path, e.detail);
    if (!emitErrorRecord(broken.error, broken.message, broken.next)) renderStructuredError(broken);
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  if (e?.name === "ConfigLockError") {
    const locked = configLockError(e.detail);
    if (!emitErrorRecord(locked.error, locked.message, locked.next)) renderStructuredError(locked);
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  if (e?.name === "LocalTokenRequiredError") {
    const refused = localTokenRequiredError(endpoint);
    if (!emitErrorRecord(refused.error, refused.message, refused.next)) {
      renderStructuredError(refused);
    }
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  // A 2xx body of a shape this CLI does not read (client/contract.ts). Matched
  // by name, like the token error above, so a copy of the class bundled
  // elsewhere is recognised too.
  if (e?.name === "BackendContractError" && typeof e.message === "string") {
    const mismatch = backendContractError(e.message, endpoint);
    if (!emitErrorRecord(mismatch.error, mismatch.message, mismatch.next)) renderStructuredError(mismatch);
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  const structured = typeof e?.message === "string" ? parseBackendError(e.message) : null;
  if (structured) {
    if (!emitErrorRecord(structured.error, structured.message, structured.next)) {
      renderStructuredError(structured);
    }
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  // formatFetchError unwraps `fetch failed` so the transport cause is visible
  // rather than being hidden behind a message that says nothing.
  const msg = err === null || err === undefined ? String(err) : formatFetchError(err);
  // `cli_error` because nothing above recognised it: the code has to stay
  // stable and honest rather than guess at a class from the message text.
  if (!emitErrorRecord("cli_error", msg)) {
    process.stderr.write(chalk.red(`Error: ${msg}\n`));
  }

  if (debug) writeDebugDetail(err);

  process.exit(1);
}
