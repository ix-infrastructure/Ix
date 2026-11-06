// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../config.js";
import type { Note, NoteSearchResult, NoteTag } from "../../client/types.js";
import { readStdin, relativeTime, renderRows, shortId } from "../memory-render.js";
import { rememberRecent, resolveRecent } from "../recent.js";

/**
 * `ix note`: create, list, show, supersede and retract notes in the local
 * memory layer (`/v1/note*`, `/v1/notes`).
 *
 * Registered only when Ix Pro is not (see `register/oss-fallbacks.ts`): Pro's
 * `note` sends the same requests to the active cloud org instead. The two keep
 * the same flags and print the backend's record unchanged under `--json`, so a
 * caller that parses `ix note --json show <id>` or
 * `ix note --tag=finding --session=s --actor=a --json < text` (Peer2Peer's
 * ext-ix does both) works against either.
 */

const VALID_TAGS: ReadonlySet<NoteTag> = new Set<NoteTag>(["finding", "decision", "reminder", "note"]);

interface CreateOpts {
  tag?: string;
  session?: string;
  node?: string[];
  actor?: string;
  json?: boolean;
}

interface ListOpts {
  tag?: string;
  actor?: string;
  q?: string;
  session?: string;
  since?: string;
  limit?: string;
  excludeSuperseded?: boolean;
}

/**
 * `--json` lives on `note` only, so `ix note --json show <id>` and
 * `ix note show <id> --json` both reach the subcommand: commander binds a flag
 * declared on the parent to the parent wherever it appears.
 */
function wantsJson(cmd: Command): boolean {
  return cmd.parent?.opts().json === true;
}

/**
 * A subcommand's options, with every flag `note` also declares (`--tag`,
 * `--session`, `--node`, `--actor`) taken from `note` when it was given there.
 * Commander binds such a flag to the parent wherever it appears, so
 * `ix note ls --tag decision` and `ix note retract <id> --actor a` would
 * otherwise drop it: the subcommand would see only its own default.
 */
function subOpts<T extends object>(cmd: Command): T {
  const own = { ...cmd.opts() } as Record<string, unknown>;
  const parent = cmd.parent;
  if (parent) {
    for (const key of ["tag", "session", "node", "actor"]) {
      if (parent.getOptionValueSource(key) === "cli") own[key] = parent.getOptionValue(key);
    }
  }
  return own as T;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** The tag (undefined when none was given), or null after reporting one that is not in VALID_TAGS (exit 1). */
function validTag(tag: string | undefined): string | undefined | null {
  if (!tag) return undefined;
  if (VALID_TAGS.has(tag as NoteTag)) return tag;
  console.error(chalk.red(`Invalid --tag "${tag}".`) + ` Valid: ${[...VALID_TAGS].join(", ")}`);
  process.exitCode = 1;
  return null;
}

/** The text argument, else whatever was piped on stdin, trimmed; undefined when both are empty. */
async function noteText(text: string | undefined): Promise<string | undefined> {
  if (text) return text;
  const piped = (await readStdin()).trim();
  return piped || undefined;
}

/**
 * The id a note subcommand addresses: `-` is the last note shown or created,
 * and anything short of a UUID is resolved as an id prefix, as Pro does.
 */
async function noteId(arg: string): Promise<string> {
  const id = resolveRecent("note", arg);
  return (await createClient()).resolvePrefix(id);
}

function printNoteDetail(n: NoteSearchResult): void {
  const lifecycle = n.lifecycleStatus ? chalk.dim(` (${n.lifecycleStatus})`) : "";
  console.log(`${chalk.bold(`[${n.tag}]`)}${lifecycle} ${shortId(n.id)}`);
  console.log(n.text);
  const meta: string[] = [];
  if (n.actor) meta.push(`by ${n.actor}`);
  meta.push(relativeTime(n.at));
  if (n.sessionName) meta.push(`session: ${n.sessionName}`);
  if (n.nodeIds && n.nodeIds.length > 0) meta.push(`refs: ${n.nodeIds.length}`);
  if (n.supersededBy && n.supersededBy.length > 0) meta.push(`superseded → ${shortId(n.supersededBy[0])}`);
  console.log(chalk.dim(meta.join(" · ")));
}

function noteRow(n: NoteSearchResult): string[] {
  const lifecycle = n.lifecycleStatus && n.lifecycleStatus !== "active" ? chalk.dim(`(${n.lifecycleStatus}) `) : "";
  const preview = (n.text ?? "").replace(/\s+/g, " ").slice(0, 60);
  return [shortId(n.id), chalk.bold(n.tag ?? ""), chalk.dim(relativeTime(n.at)), n.actor ?? "—", `${lifecycle}${preview}`];
}

export function registerNoteCommand(program: Command): void {
  const note = program
    .command("note [text]")
    .description("Create or manage notes in the ix memory layer")
    .option("--tag <tag>", "finding|decision|reminder|note", "note")
    .option("--session <name>", "Attach note to a session (by name or id)")
    .option("--node <ids...>", "Node IDs to reference (creates REFERENCES edges)")
    .option("--actor <name>", "Actor recording the note")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  ix note "Auth uses RS256 for key rotation" --tag decision
  ix note --tag finding --session sprint-23 < draft.md
  ix note ls --tag decision --limit 10
  ix note show <id>
  ix note supersede <id> "Updated decision text" --tag decision
  ix note retract <id>
`,
    )
    .action(async (text: string | undefined, opts: CreateOpts) => {
      const tag = validTag(opts.tag);
      if (tag === null) return;
      const body = await noteText(text);
      if (!body) {
        console.error(chalk.red("Note text required."));
        console.error(chalk.dim('  ix note "your text" --tag finding'));
        console.error(chalk.dim("  cat draft.md | ix note --tag finding"));
        process.exitCode = 1;
        return;
      }
      const client = await createClient();
      const created = await client.createNote({
        text: body,
        tag,
        actor: opts.actor,
        sessionId: opts.session,
        nodeIds: opts.node,
      });
      rememberRecent("note", created.id);
      if (opts.json) return printJson(created);
      console.log(`${chalk.green("✓")} note ${shortId(created.id)} ${chalk.bold(`[${created.tag}]`)}`);
      if (opts.session) console.log(chalk.dim(`  session: ${opts.session}`));
    });

  note
    .command("ls")
    .description("List or search notes")
    .option("--tag <tag>", "Filter by tag")
    .option("--actor <name>", "Filter by actor")
    .option("--q <text>", "Keyword filter")
    .option("--session <name>", "Restrict to a session's notes")
    .option("--since <iso>", "Only notes created after this ISO timestamp")
    .option("--limit <n>", "Max results (default 50)")
    .option("--exclude-superseded", "Hide superseded notes")
    .action(async (_opts: ListOpts, cmd: Command) => {
      const opts = subOpts<ListOpts>(cmd);
      const tag = validTag(opts.tag);
      if (tag === null) return;
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
      if (limit != null && (Number.isNaN(limit) || limit <= 0)) {
        console.error(chalk.red("--limit must be a positive integer"));
        process.exitCode = 1;
        return;
      }

      const client = await createClient();
      let notes: NoteSearchResult[];
      if (opts.session) {
        // A session's notes come from their own route, in the lighter Note
        // shape (no sessionId/lifecycleStatus), and are filtered here.
        const q = opts.q?.toLowerCase();
        const raw: Note[] = await client.sessionNotes(opts.session);
        notes = raw
          .filter((n) => (tag ? n.tag === tag : true))
          .filter((n) => (opts.actor ? n.actor === opts.actor : true))
          .filter((n) => (q ? n.text.toLowerCase().includes(q) : true))
          .slice(0, limit ?? 50);
      } else {
        notes = await client.listNotes({
          tag,
          actor: opts.actor,
          q: opts.q,
          since: opts.since,
          limit,
          includeSuperseded: opts.excludeSuperseded ? false : undefined,
        });
      }

      if (wantsJson(cmd)) return printJson(notes);
      if (notes.length === 0) {
        console.log(chalk.dim("No notes found."));
        return;
      }
      console.log(renderRows(["ID", "TAG", "AGE", "ACTOR", "TEXT"], notes.map(noteRow)));
      console.log(chalk.dim(`${notes.length} notes`));
    });

  note
    .command("show <id>")
    .description("Show a single note. Pass `-` for the last-shown note.")
    .action(async (idArg: string, _opts: unknown, cmd: Command) => {
      const id = await noteId(idArg);
      const n = await (await createClient()).getNote(id);
      rememberRecent("note", id);
      if (wantsJson(cmd)) return printJson(n);
      printNoteDetail(n);
    });

  note
    .command("supersede <id> [text]")
    .description("Replace a note (preserves SUPERSEDES edge). Pass `-` for the last-shown note.")
    .option("--tag <tag>", "Tag for the new note (defaults to original)", "note")
    .option("--session <name>", "Attach replacement to session")
    .option("--node <ids...>", "Node IDs to reference")
    .option("--actor <name>", "Actor recording the supersede")
    .action(async (idArg: string, text: string | undefined, _opts: Omit<CreateOpts, "json">, cmd: Command) => {
      const opts = subOpts<Omit<CreateOpts, "json">>(cmd);
      const tag = validTag(opts.tag);
      if (tag === null) return;
      const body = await noteText(text);
      if (!body) {
        console.error(chalk.red("Replacement text required."));
        process.exitCode = 1;
        return;
      }
      const id = await noteId(idArg);
      const result = await (await createClient()).supersedeNote(id, {
        text: body,
        tag,
        actor: opts.actor,
        sessionId: opts.session,
        nodeIds: opts.node,
      });
      rememberRecent("note", result.newNote.id);
      if (wantsJson(cmd)) return printJson(result);
      console.log(`${chalk.green("✓")} superseded ${shortId(id)} → ${shortId(result.newNote.id)}`);
    });

  note
    .command("retract <id>")
    .description("Soft-delete a note. Pass `-` for the last-shown note.")
    .option("--actor <name>", "Actor performing the retraction")
    .action(async (idArg: string, _opts: { actor?: string }, cmd: Command) => {
      const opts = subOpts<{ actor?: string }>(cmd);
      const id = await noteId(idArg);
      const result = await (await createClient()).retractNote(id, opts.actor);
      if (wantsJson(cmd)) return printJson(result);
      console.log(`${chalk.green("✓")} retracted ${shortId(id)}`);
    });
}
