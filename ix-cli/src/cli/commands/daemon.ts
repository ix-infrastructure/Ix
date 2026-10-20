// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

import { request } from "../daemon/client.js";
import { daemonDisabled, daemonPaths, PROTOCOL_VERSION, type DaemonReply } from "../daemon/protocol.js";

type Info = Extract<DaemonReply, { status: "info" }>;

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Why the daemon is not used here, or null when it is. */
function notUsedReason(): string | null {
  if (process.platform === "win32") return "not used on Windows";
  if (daemonDisabled(process.env)) return "IX_DAEMON=off: neither used nor started";
  return null;
}

async function probe(socket: string): Promise<Info | undefined> {
  const attempt = await request(socket, { v: PROTOCOL_VERSION, kind: "status" }, 2000);
  return attempt.kind === "reply" && attempt.reply.status === "info" ? attempt.reply : undefined;
}

/**
 * `ix daemon`: look at, or stop, the warm process that answers agents' read
 * commands (see `cli/daemon/`). It starts itself and exits when idle, so
 * neither is ever needed to use Ix.
 */
export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("The warm background process that answers agents' read commands (status, stop)");

  daemon
    .command("status")
    .description("Show whether the daemon is running: pid, build, uptime, runs served, memory")
    .option("--json", "Print the status as one JSON object")
    .action(async (opts: { json?: boolean }) => {
      const paths = process.platform === "win32" ? null : daemonPaths(process.env);
      const info = paths ? await probe(paths.socket) : undefined;
      const unused = notUsedReason();
      if (opts.json) {
        console.log(JSON.stringify({
          running: info !== undefined,
          enabled: unused === null,
          ...(info
            ? {
              pid: info.pid, build: info.build, startedAt: info.startedAt, uptimeMs: info.uptimeMs,
              served: info.served, fallbacks: info.fallbacks, rssBytes: info.rssBytes,
            }
            : {}),
          socket: paths?.socket ?? null,
        }));
        return;
      }
      const lines = [`Ix daemon: ${info ? "running" : "not running"}${unused ? ` (${unused})` : ""}`];
      if (info) {
        lines.push(
          `  pid:     ${info.pid}`,
          `  build:   ${info.build}`,
          `  uptime:  ${formatUptime(info.uptimeMs)}`,
          `  served:  ${info.served} runs${info.fallbacks > 0 ? ` (${info.fallbacks} handed back to run cold)` : ""}`,
          `  rss:     ${(info.rssBytes / (1024 * 1024)).toFixed(1)} MB`,
        );
      }
      if (paths) lines.push(`  socket:  ${paths.socket}`);
      console.log(lines.join("\n"));
    });

  daemon
    .command("stop")
    .description("Stop the daemon; the next agent call starts a fresh one unless IX_DAEMON=off")
    .action(async () => {
      const paths = process.platform === "win32" ? null : daemonPaths(process.env);
      const attempt = paths ? await request(paths.socket, { v: PROTOCOL_VERSION, kind: "stop" }, 2000) : undefined;
      if (!paths || attempt?.kind !== "reply" || attempt.reply.status !== "stopping") {
        console.log("Ix daemon: not running");
        return;
      }
      // It takes itself off the socket before it replies; wait for the process
      // to be gone too, briefly, so `stop` then `status` reads as stopped.
      const { pid } = attempt.reply;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && alive(pid)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      console.log(`Ix daemon: stopped (pid ${pid})`);
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
