// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { currentRunSignal } from "../client/run-signal.js";
import { isLoopbackEndpoint } from "./endpoint.js";
import { ixHome } from "./ix-home.js";

/**
 * Small helpers shared by `ix note` and `ix session` (commands/note.ts,
 * commands/session.ts). Their text output is for a person; the contract is
 * their `--json`, which prints the backend's record unchanged.
 */

/** The first 8 characters of an id, dimmed: enough to tell rows apart, and a prefix `show` accepts. */
export function shortId(id: string | undefined | null): string {
  return id ? chalk.dim(id.slice(0, 8)) : chalk.dim("—");
}

/** "just now", "5m ago", "3h ago", "2d ago", "4w ago"; "—" for a missing or unparseable time. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI, "").length;

/** Rows padded into columns two spaces apart under dimmed headers. The last column is not padded. */
export function renderRows(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i]! - visibleLength(cell))))
      .join("  ")
      .trimEnd();
  return [chalk.dim(line(headers)), ...rows.map(line)].join("\n");
}

/** The most a note may read from stdin. */
export const STDIN_MAX_BYTES = 1024 * 1024;
/**
 * How long stdin may go without a byte (or EOF) before the read gives up,
 * reset by every chunk. Generous, so a slow producer (`git log | ix note`, an
 * LLM streaming into a pipe) is never cut off; `IX_STDIN_IDLE_MS` overrides
 * it, and 0 turns it off.
 */
export const STDIN_IDLE_MS = 5 * 60_000;

/** The idle bound in effect: `IX_STDIN_IDLE_MS` when it is a non-negative number, else STDIN_IDLE_MS. */
export function stdinIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IX_STDIN_IDLE_MS?.trim();
  if (!raw) return STDIN_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : STDIN_IDLE_MS;
}

/**
 * All of stdin, or "" when it is a terminal: text is only ever piped in, never
 * typed at a prompt. Rejects past `maxBytes`, and when the pipe stays silent
 * for `idleMs`: a caller that leaves stdin open and sends nothing (an agent
 * harness's inherited pipe) gets an error rather than a hang.
 *
 * Refuses inside an `ix mcp` in-process run (`currentRunSignal`): there,
 * process.stdin is the MCP transport, and reading it would swallow the
 * protocol stream.
 */
export function readStdin(opts: { maxBytes?: number; idleMs?: number } = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? STDIN_MAX_BYTES;
  const idleMs = opts.idleMs ?? stdinIdleMs();
  if (currentRunSignal()) {
    return Promise.reject(new Error("Pass the note text as an argument: stdin is the MCP transport under `ix mcp`."));
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve("");
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    const finish = (err: Error | undefined, value?: string) => {
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.pause();
      if (err) reject(err);
      else resolve(value ?? "");
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (idleMs <= 0) return;
      timer = setTimeout(() => finish(new Error(`No input on stdin for ${Math.round(idleMs / 1000)}s: pass the text as an argument, or close stdin.`)), idleMs);
      timer.unref?.();
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return finish(new Error(`Input on stdin is over ${Math.round(maxBytes / 1024)} KiB; a note is limited to that.`));
      chunks.push(buf);
      arm();
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks).toString("utf-8"));
    const onError = (err: Error) => finish(err);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    arm();
  });
}

/**
 * Say on stderr which backend a write went to -- with `--json` too, since the
 * record on stdout does not. Without it, a Pro user whose `ix` cannot resolve
 * `@ix/pro` (npx, a project-local bin, another prefix) would have notes land
 * on the local backend, or fail against the cloud, with nothing saying why.
 *
 * Also, once per run, when config.yaml holds Pro's cloud state (`active`,
 * `cluster` or a legacy `instances` map) but Pro did not load here.
 */
export function reportWriteTarget(endpoint: string): void {
  if (!proWarningShown && hasProState()) {
    proWarningShown = true;
    process.stderr.write(
      "ix: config.yaml has Ix Pro cloud settings, but this ix could not load @ix/pro, " +
      "so this command uses the OSS backend below rather than your cloud org. " +
      "Run the ix that has Pro installed for cloud notes.\n",
    );
  }
  const where = isLoopbackEndpoint(endpoint) ? "local backend" : "backend";
  process.stderr.write(chalk.dim(`→ ${where} ${displayEndpoint(endpoint)}`) + "\n");
}

/**
 * `endpoint` without credentials or query: origin and path only, so a URL
 * carrying `user:pass@` or a `?token=` is never echoed into a log or an
 * agent's tool output. Unparseable input is not printed at all.
 */
export function displayEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return "(unparseable endpoint)";
  }
}

let proWarningShown = false;

/** Whether config.yaml carries one of the top-level keys Ix Pro's cloud config writes. */
function hasProState(): boolean {
  try {
    return /^(active|cluster|instances):/m.test(readFileSync(join(ixHome(), "config.yaml"), "utf-8"));
  } catch {
    return false;
  }
}

/** A y/N question on stderr. False without asking when stdin is not a terminal: a script must pass --force. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
