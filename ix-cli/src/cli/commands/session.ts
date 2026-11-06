// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../config.js";
import type { SessionInfo } from "../../client/types.js";
import { confirm, relativeTime, renderRows, shortId } from "../memory-render.js";
import { rememberRecent, resolveRecent } from "../recent.js";

/**
 * `ix session`: list, create, show, join, pin and delete sessions in the local
 * memory layer (`/v1/session*`, `/v1/sessions`).
 *
 * Registered only when Ix Pro is not (see `register/oss-fallbacks.ts`): Pro's
 * `session` sends the same requests to the active cloud org, and adds
 * `session load`, which picks sessions interactively and pipes them into an
 * agent. Flags and `--json` output are Pro's, so a caller works against either.
 */

interface ParentOpts {
  json?: boolean;
  format?: string;
}

/** `--json` / `--format` live on `session` only; see `wantsJson` in note.ts. */
function wantsJson(cmd: Command): boolean {
  const parent = cmd.parent?.opts() ?? {};
  return parent.json === true || parent.format === "json";
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printSessionDetail(s: SessionInfo): void {
  console.log(`${chalk.bold(s.name)} ${shortId(s.sessionId)}`);
  console.log(`  purpose: ${s.purpose}`);
  console.log(`  actor:   ${s.actor}`);
  if (s.actors.length > 1) console.log(`  actors:  ${s.actors.join(", ")}`);
  console.log(`  ttl:     ${s.ttlHours}h`);
  console.log(`  created: ${chalk.dim(relativeTime(s.createdAt))}`);
  if (s.lastLoadedAt) console.log(`  loaded:  ${chalk.dim(relativeTime(s.lastLoadedAt))}`);
}

export function registerSessionCommand(program: Command): void {
  // Positional [actor] rather than --actor: create and join declare their own
  // required --actor, and commander would bind a parent --actor instead.
  const session = program
    .command("session [actor]")
    .description("List and manage memory-layer sessions")
    .option("--json", "Output as JSON")
    .option("--format <fmt>", "Output format (text|json) — --format json is equivalent to --json")
    .addHelpText(
      "after",
      `
Examples:
  ix session                                          # list all sessions
  ix session tkocher                                  # list sessions for tkocher
  ix session create my-sesh --purpose "..." --actor tkocher
  ix session show my-sesh
  ix session join my-sesh --actor claude
  ix session pin my-sesh <nodeId>
  ix session delete my-sesh
`,
    )
    .action(async (actor: string | undefined, opts: ParentOpts) => {
      const sessions = await (await createClient()).listSessions(actor);
      if (opts.json || opts.format === "json") return printJson(sessions);
      if (sessions.length === 0) {
        console.log(chalk.dim("No sessions found."));
        return;
      }
      console.log(
        renderRows(
          ["SESSION", "NAME", "ACTOR", "AGE", "LAST LOADED", "TTL", "PURPOSE"],
          sessions.map((s) => [
            shortId(s.sessionId),
            chalk.bold(s.name),
            s.actor,
            chalk.dim(relativeTime(s.createdAt)),
            chalk.dim(relativeTime(s.lastLoadedAt)),
            `${s.ttlHours}h`,
            (s.purpose ?? "").slice(0, 60),
          ]),
        ),
      );
      console.log(chalk.dim(`${sessions.length} sessions`));
    });

  session
    .command("create [name]")
    .description("Create a new session (name auto-generated if omitted)")
    .requiredOption("--purpose <text>", "What this session is for")
    .requiredOption("--actor <name>", "Actor creating the session")
    .option("--ttl <hours>", "TTL in hours (default 24)")
    .action(async (name: string | undefined, opts: { purpose: string; actor: string; ttl?: string }, cmd: Command) => {
      let ttlHours: number | undefined;
      if (opts.ttl) {
        ttlHours = parseInt(opts.ttl, 10);
        if (Number.isNaN(ttlHours) || ttlHours <= 0) {
          console.error(chalk.red("--ttl must be a positive integer (hours)"));
          process.exitCode = 1;
          return;
        }
      }
      const s = await (await createClient()).createSession({ name, purpose: opts.purpose, actor: opts.actor, ttlHours });
      rememberRecent("session", s.sessionId);
      if (wantsJson(cmd)) return printJson(s);
      console.log(`${chalk.green("✓")} ${chalk.bold(s.name)} ${shortId(s.sessionId)}`);
      console.log(`  purpose: ${s.purpose}`);
      console.log(`  actor:   ${s.actor} · ttl: ${s.ttlHours}h`);
      console.log(chalk.dim(`next: ix session show - or ix note "..." --session ${s.name}`));
    });

  session
    .command("show <nameOrId>")
    .description("Show session details. Pass `-` for the last-shown session.")
    .action(async (arg: string, _opts: unknown, cmd: Command) => {
      const s = await (await createClient()).getSession(resolveRecent("session", arg));
      // The id, not the name, so `-` stays unambiguous across renames and duplicate names.
      rememberRecent("session", s.sessionId);
      if (wantsJson(cmd)) return printJson(s);
      printSessionDetail(s);
    });

  session
    .command("join <nameOrId>")
    .description("Add an actor to a session. Pass `-` for the last-shown session.")
    .requiredOption("--actor <name>", "Actor joining the session")
    .action(async (arg: string, opts: { actor: string }, cmd: Command) => {
      const s = await (await createClient()).joinSession(resolveRecent("session", arg), opts.actor);
      if (wantsJson(cmd)) return printJson(s);
      console.log(`${chalk.green("✓")} ${chalk.bold(opts.actor)} joined ${chalk.bold(s.name)} (${s.actors.length} actors)`);
    });

  session
    .command("pin <nameOrId> <nodeIds...>")
    .description("Pin node IDs to a session. Pass `-` for the last-shown session.")
    .action(async (arg: string, nodeIds: string[], _opts: unknown, cmd: Command) => {
      const nameOrId = resolveRecent("session", arg);
      const result = await (await createClient()).pinSessionNodes(nameOrId, nodeIds);
      if (wantsJson(cmd)) return printJson(result);
      console.log(`${chalk.green("✓")} pinned ${result.count} node(s) to ${chalk.bold(nameOrId)}`);
    });

  // Deletes the session row only: the backend keeps the notes that reference it.
  session
    .command("delete <nameOrId>")
    .description("Delete a session (metadata only). Pass `-` for the last-shown session.")
    .option("--force", "Skip the confirmation prompt")
    .action(async (arg: string, opts: { force?: boolean }, cmd: Command) => {
      const nameOrId = resolveRecent("session", arg);
      if (!opts.force) {
        // A script cannot answer the prompt: refuse loudly, so a caller that
        // forgot --force does not read exit 0 as "deleted".
        if (!process.stdin.isTTY) {
          console.error(chalk.red(`Refusing to delete session "${nameOrId}" without --force: no terminal to confirm on.`));
          process.exitCode = 1;
          return;
        }
        if (!(await confirm(`Delete session "${nameOrId}"? (notes are preserved)`))) {
          console.error(chalk.dim("Cancelled."));
          return;
        }
      }
      const result = await (await createClient()).deleteSession(nameOrId);
      if (wantsJson(cmd)) return printJson(result);
      console.log(`${chalk.green("✓")} deleted session ${chalk.dim(nameOrId)}`);
    });
}
