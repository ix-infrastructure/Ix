// Copyright 2026 Ix Infrastructure Inc.

import { createInterface } from "node:readline";
import chalk from "chalk";

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

/** All of stdin, or "" when it is a terminal: text is only ever piped in, never typed at a prompt. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
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
