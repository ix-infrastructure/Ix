// Copyright 2026 Ix Infrastructure Inc.

// Saved investigations (`--save`, `--resume`, `--list`): where they live, how
// ids are stored, and how a saved bundle is loaded and listed.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BUNDLE_SCHEMA, contextBundleSchema, savedInvestigationSchema } from "../context-bundle-schema.js";
import { llmLine, printLlmLines } from "../llm.js";
import { renderNote, renderSection, renderWarning, renderWarningErr, reportFailure } from "../ui.js";
import { printJson } from "../format.js";

import { renderBundle } from "./render.js";
import type { ContextBundle } from "./types.js";
import { cmp } from "./util.js";

/** Saved investigation state lives under ~/.ix/investigations. */
function investigationDir(): string {
  // IX_HOME is the Ix home *directory*, not the investigations directory —
  // backend-status.ts, docker.ts and upgrade.ts all read it as `IX_HOME ||
  // ~/.ix` and then join their own subdirectory onto it. Putting the subdirectory
  // only in the fallback made the two branches disagree: with IX_HOME set, saved
  // investigations landed loose in the Ix home beside config.yaml, bin/ and cli/,
  // and `investigations/` was never created at all.
  return join(process.env.IX_HOME || join(homedir(), ".ix"), "investigations");
}

function investigationPath(id: string): string {
  return join(investigationDir(), `${sanitizeId(id)}.json`);
}

/**
 * Encode an investigation id into a filesystem-safe file name, injectively.
 *
 * `[A-Za-z0-9._-]` passes through unchanged; every other UTF-16 code unit —
 * including the escape marker `~` itself — is hex-encoded, as `~HH` below
 * U+0100 and `~uHHHH` at or above it. Two different logical ids can therefore
 * never map to the same file, and a raw `~` in user input cannot be confused
 * with an encoding: `a/b`, `a?b`, and `a~2Fb` all land in distinct,
 * single-segment files under the investigation directory instead of silently
 * colliding or escaping it.
 *
 * A leading `.` is encoded too, so no id can produce a dotfile. `.` is otherwise
 * an ordinary character here, and encoding it only in first position keeps the
 * mapping injective: `.a` becomes `~2Ea`, which no other id can also produce.
 */
export function sanitizeId(id: string): string {
  let out = "";
  // Iterate UTF-16 code units, not code points. `for...of` walks code points
  // while `charCodeAt(0)` reads only the leading surrogate, so every astral
  // character encoded as just its high surrogate and they all collided (#478).
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
      continue;
    }
    const code = id.charCodeAt(i);
    // Two escape widths, and the `u` is what keeps them apart. A bare
    // `~HHHH` would be ambiguous: `~D83D` reads equally well as one code unit
    // or as `~D8` followed by the literal characters `3D`, and hex digits pass
    // through unencoded, so both readings are producible. That is not
    // hypothetical — it is how U+1F600 collided with the ordinary string
    // `Ø3DÞ00`, which is the same overwrite bug #478 was about, one layer down.
    //
    // `u` cannot be confused with the narrow form because it is not a hex
    // digit, and a literal `~` in the input is itself encoded (`~7E`), so the
    // character after an escape marker is never user data.
    //
    // The narrow form is kept for everything below U+0100 so that every id
    // already on disk keeps the name it was saved under.
    out += code < 0x100
      ? `~${code.toString(16).toUpperCase().padStart(2, "0")}`
      : `~u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  if (out.startsWith(".")) out = `~2E${out.slice(1)}`;
  return out || "unnamed";
}

/**
 * The id to show the user, given the id stored on disk.
 *
 * `sanitizeId` is deliberately *not* idempotent — it encodes `~` as `~7E` so a
 * raw `~` cannot be mistaken for an escape — so the stored form is the wrong
 * thing to hand back. `ix context --list` printed it next to "Resume with:
 * ix context --resume <id>", and `--resume` sanitizes what it is given: an id
 * saved as `widget/auth` was listed as `widget~2Fauth`, and resuming that
 * looked for `widget~7E2Fauth`, which does not exist.
 *
 * Decodes both escape widths and then re-encodes to check itself, rather than
 * trusting the decode. The check is not ceremony: ids written before the
 * `~uHHHH` form existed still carry bare `~HHHH`, which decodes to a different
 * string than it was saved from, and the re-encode is what catches that and
 * returns the stored id untouched instead of showing a plausible wrong answer.
 * `loadInvestigation` accepts the stored form too, so a listed id loads either
 * way — the display is the nicety, the load is the contract.
 */
export function displayId(stored: string): string {
  const decoded = stored.replace(
    /~u([0-9A-Fa-f]{4})|~([0-9A-Fa-f]{2})/g,
    (_m, wide: string | undefined, narrow: string | undefined) =>
      String.fromCharCode(parseInt(wide ?? narrow ?? "", 16)),
  );
  return sanitizeId(decoded) === stored ? decoded : stored;
}

/**
 * The shape `sanitizeId` produces: what a file in the investigations directory
 * can be named, and therefore what `loadInvestigation` may accept verbatim.
 *
 * The leading character excludes `.` so no input names a dotfile, and the set
 * excludes every path separator, so nothing here can address a second directory
 * segment or a parent.
 */
const STORED_ID = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

export function saveInvestigation(id: string, bundle: ContextBundle): void {
  const dir = investigationDir();
  mkdirSync(dir, { recursive: true });
  // Refuse to persist a bundle that does not match the versioned contract:
  // network-derived investigation state is validated before it reaches disk
  // (CodeQL js/network-data-written-to-file).
  const parsed = contextBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    renderWarning(`Refusing to save investigation "${id}": the bundle does not match the ${BUNDLE_SCHEMA} schema (${parsed.error.issues.length} issue(s)).`);
    return;
  }
  const state = {
    schema: "ix-investigation/1",
    id: sanitizeId(id),
    savedAt: new Date().toISOString(),
    bundle: parsed.data,
  };
  // Atomic write (temp + rename in the same directory), matching the config
  // writer, so a saved investigation is never partially written (CodeQL
  // js/file-system-race).
  const path = investigationPath(id);
  const tmpPath = join(dirname(path), `.${process.pid}.${Date.now().toString(36)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export interface SavedInvestigation {
  schema: string;
  id: string;
  savedAt: string;
  bundle: ContextBundle;
}

/**
 * Carry the saved investigation's revision and depth into a fresh `--diff`
 * build unless the caller explicitly overrides them, so a plain
 * `ix context --diff <id>` compares like-for-like instead of silently
 * re-basing the saved state onto current HEAD.
 */
export function mergeDiffOptions(
  saved: SavedInvestigation,
  opts: { asOfRev?: number; depth?: string },
): { asOfRev?: number; depth?: string } {
  // Numbers on both sides now: `--as-of-rev` is validated by its Commander
  // argParser, so the round trip through a string that this used to do -- and
  // the `parseInt` on the far side of it -- is gone.
  return {
    asOfRev: opts.asOfRev ?? saved.bundle.metadata.asOfRev,
    depth: opts.depth ?? saved.bundle.metadata.depth,
  };
}

/**
 * Enumerate every saved investigation under IX_HOME/investigations.
 *
 * Validated with `savedInvestigationSchema` — the same contract the write side
 * and `loadInvestigation` enforce — rather than a hand-rolled envelope check
 * beside it. A file that fails it is skipped and counted; the count is
 * returned, not printed, because this runs before the renderer knows which
 * format was asked for.
 *
 * Determinism: newest first by `savedAt`, falling back to the id so two files
 * saved in the same millisecond still order stably across runs.
 */
export function listInvestigations(): { saved: SavedInvestigation[]; skipped: number } {
  const dir = investigationDir();
  if (!existsSync(dir)) return { saved: [], skipped: 0 };
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: SavedInvestigation[] = [];
  let skipped = 0;
  for (const file of entries) {
    let raw: unknown;
    // Scoped to the read and the parse, as in `loadInvestigation`: they are the
    // only calls here that throw.
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      skipped += 1;
      continue;
    }
    const parsed = savedInvestigationSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    // The validated value, not the raw parse — the same assertion
    // `loadInvestigation` makes, and for the same reason: it re-narrows the
    // open report arrays the schema leaves as records, and every field the
    // renderer dereferences has been checked by this point. The id is decoded
    // here too, so every reader of an enumerated investigation sees the id it
    // can type back — see `displayId`.
    const state = parsed.data as unknown as SavedInvestigation;
    out.push({ ...state, id: displayId(state.id) });
  }
  out.sort((a, b) => {
    if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
    return cmp(a.id, b.id);
  });
  return { saved: out, skipped };
}

/** One saved investigation as `--list` describes it: what it is, not what is in it. */
interface InvestigationSummary {
  /** The id to type back, not the id on disk — decoded by `displayId` on read. */
  id: string;
  savedAt: string;
  target: { name: string; kind: string };
  freshness: ContextBundle["freshness"];
  counts: { entities: number; relationships: number; evidence: number };
  truncation: ContextBundle["truncation"];
}

/** Summarise one saved investigation for the listing. */
function summariseInvestigation(s: SavedInvestigation): InvestigationSummary {
  const b = s.bundle;
  return {
    id: s.id,
    savedAt: s.savedAt,
    target: { name: b.target.name, kind: b.target.kind },
    freshness: b.freshness,
    counts: {
      entities: b.entities.length,
      relationships: b.relationships.length,
      evidence: b.evidence.length,
    },
    truncation: b.truncation,
  };
}

/**
 * Render the saved investigations produced by `listInvestigations`.
 *
 * Every format carries the same summary: what each investigation is, how big
 * it is, and how stale. Not the bundles themselves — `--list` is the discovery
 * step, and twenty saved investigations is twenty complete bundles, up to 50
 * entities, 100 relationships and 12000 characters of evidence each. A caller
 * that wants one of them asks for it by id with `--resume <id> --format json`.
 *
 * `skipped` is reported in each format's own terms, and never on stdout except
 * as a field — including in `json`, which returns an object for exactly that
 * reason: an array has nowhere to put it, so a machine caller could not tell
 * that files had been rejected while the human saw a warning saying so. It used
 * to be a `renderWarning` inside the enumerator — which is `console.log` — so a
 * single corrupt file prepended a chalk-coloured prose line to the payload and
 * `ix context --list --format json | jq` failed on it. The human warning goes to
 * stderr; the machine formats carry a count.
 */
export function renderInvestigationList(
  items: SavedInvestigation[],
  skipped: number,
  format: string,
): void {
  const summaries = items.map(summariseInvestigation);
  if (skipped > 0 && format !== "llm") {
    // `console.error`, not `renderWarning`: every renderer in ui.ts writes to
    // stdout, which is exactly how this line used to end up inside the JSON a
    // caller was piping. Plain text rather than chalk — nothing else in this
    // file writes to stderr, and a colour code is not worth an import that
    // only this line needs.
    renderWarningErr(
      `${skipped} saved investigation file(s) in ${investigationDir()} did not match the contract; skipped.`,
    );
  }
  if (format === "json") {
    printJson({ investigations: summaries, skipped });
    return;
  }
  if (format === "llm") {
    printLlmLines([
      // `skipped` is a field rather than a warning: it is the one thing about
      // the listing an agent cannot see from the records themselves.
      llmLine("investigations", { total: summaries.length, skipped: skipped || undefined }),
      ...summaries.map((s) =>
        llmLine("investigation", {
          id: s.id,
          saved_at: s.savedAt,
          target: s.target.name,
          target_kind: s.target.kind,
          classification: s.freshness.classification,
          stale: s.freshness.stale,
          entities: s.counts.entities,
          relationships: s.counts.relationships,
          evidence: s.counts.evidence,
          truncated_entities: s.truncation.entitiesTruncated,
          truncated_relationships: s.truncation.relationshipsTruncated,
          truncated_evidence: s.truncation.evidenceTruncated,
          truncated_chars: s.truncation.charactersTruncated,
        }),
      ),
    ]);
    return;
  }

  if (summaries.length === 0) {
    renderNote("No saved investigations. Use `ix context <target> --save <id>` to create one.");
    return;
  }
  renderSection(`Saved investigations (${summaries.length})`);
  for (const s of summaries) {
    console.log(`  ${s.id}`);
    console.log(`    target:       ${s.target.name} (${s.target.kind})`);
    console.log(`    saved_at:     ${s.savedAt}`);
    console.log(`    freshness:    ${s.freshness.classification}`);
    console.log(
      `    counts:       entities=${s.counts.entities} relationships=${s.counts.relationships} evidence=${s.counts.evidence}`,
    );
    if (
      s.truncation.entitiesTruncated ||
      s.truncation.relationshipsTruncated ||
      s.truncation.evidenceTruncated ||
      s.truncation.charactersTruncated
    ) {
      console.log(
        `    truncated:    entities=${s.truncation.entitiesTruncated} relationships=${s.truncation.relationshipsTruncated} evidence=${s.truncation.evidenceTruncated} chars=${s.truncation.charactersTruncated}`,
      );
    }
  }
  console.log();
  console.log(`Resume with: ix context --resume <id>`);
  console.log(`Diff with:   ix context --diff <id>`);
}

/**
 * Refuse a saved investigation: warn, and set a non-zero status so a scripted
 * `--resume`/`--diff` can tell a refusal from a successful render. The sibling
 * commands (config, init, map) already signal refusals this way.
 */
function refuseInvestigation(code: string, message: string, format?: string): undefined {
  // `--format llm` gets the record every sibling command emits for a failure
  // (`callers.ts`, `contains.ts`, `depends.ts`, `diff.ts`, `history.ts` all do
  // this, and docs/llm-format.md specifies the shape). This path used to write
  // `renderWarning`, which is `console.log`, so the one command being made
  // llm-clean answered a refusal with a chalk-coloured prose line in the middle
  // of the record stream — and with a prose line inside the JSON payload for a
  // `--format json` caller piping to `jq`. The human keeps the same wording, on
  // stderr, where prose belongs whatever the format.
  reportFailure(code, message, format);
  return undefined;
}

export function loadInvestigation(id: string, format?: string): SavedInvestigation | undefined {
  let path = investigationPath(id);
  if (!existsSync(path) && STORED_ID.test(id)) {
    // Also accept the on-disk form. `sanitizeId` is not idempotent, so an id
    // that is already encoded gets encoded again and misses its own file:
    // `widget/auth` is stored as `widget~2Fauth`, and asking for
    // `widget~2Fauth` looked for `widget~7E2Fauth`. `displayId` recovers the
    // typed form for every Latin-1 id, but the escape width is ambiguous above
    // that, so for the rest the encoded name is the only thing a listing can
    // print — and it has to work. Second, not first, so an id that is genuinely
    // spelled `widget~2Fauth` still finds its own file before this.
    const encoded = join(investigationDir(), `${id}.json`);
    if (existsSync(encoded)) path = encoded;
  }
  if (!existsSync(path)) {
    return refuseInvestigation("no_saved_investigation", `No saved investigation "${id}" at ${path}`, format);
  }
  let raw: unknown;
  // Scoped to the read and the parse: those are the only calls here that throw,
  // and widening it would report a validation or rendering failure below as
  // "not valid JSON" — naming the wrong cause on a file that parses fine.
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuseInvestigation("invalid_saved_investigation", `Saved investigation "${id}" is not valid JSON; refusing to resume.`, format);
  }

  // Validate the whole envelope coming back off disk against the same versioned
  // contract the write side enforces (saveInvestigation and --out). The two
  // halves were asymmetric: writes were schema-checked, reads trusted a bare
  // `as` cast guarded only by a truthiness check on `bundle`. That gap is
  // reachable — `--diff` re-resolves `bundle.target.name`, `metadata.depth` and
  // `metadata.asOfRev` and sends them to the backend, and `--resume` renders the
  // bundle — so a file whose `schema` field was right and whose body was
  // anything at all used to be honoured.
  const parsed = savedInvestigationSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // Distinguish the two version-skew cases from a generic shape mismatch, so
    // the warning names which contract was not met.
    if (issues.some((issue) => issue.path[0] === "schema")) {
      return refuseInvestigation("invalid_saved_investigation", `Saved investigation "${id}" has an unknown schema; refusing to resume.`, format);
    }
    if (issues.some((issue) => issue.path[0] === "bundle" && issue.path[1] === "schema")) {
      return refuseInvestigation(
        "invalid_saved_investigation",
        `Saved investigation "${id}" holds a bundle from a different contract than ${BUNDLE_SCHEMA}; refusing to resume.`,
        format,
      );
    }
    return refuseInvestigation(
      "invalid_saved_investigation",
      `Saved investigation "${id}" does not match the ${BUNDLE_SCHEMA} schema (${issues.length} issue(s)); refusing to resume.`,
      format,
    );
  }
  // Return the validated value, not the raw parse: saveInvestigation persists
  // `parsed.data` for the same reason, so unknown keys smuggled into a
  // hand-edited file are dropped here rather than echoed back out by
  // `--resume --format json` or copied into the emitted diff.
  //
  // The assertion re-narrows the three report arrays the schema deliberately
  // leaves as open records (decisions/conflicts/intents, whose shapes belong to
  // the backend) plus the literals zod widens to `string`. Every field this file
  // dereferences has been checked by this point — unlike the `as` cast on raw
  // JSON.parse output that this replaces, which checked nothing.
  //
  // The id is decoded here, at the one boundary every reader comes through,
  // rather than at each place one is printed. Decoding per call site is how
  // `--format llm` came to report `widget/auth` while `--format json` and the
  // text header reported `widget~2Fauth` for the same investigation, and a
  // JSON-chaining caller fed the second back to `--resume` and was refused.
  const state = parsed.data as unknown as SavedInvestigation;
  return { ...state, id: displayId(state.id) };
}

export function renderSavedInvestigation(id: string, format: string): void {
  const saved = loadInvestigation(id, format);
  if (!saved) return;
  if (format === "json") {
    printJson(saved);
    return;
  }
  if (format === "llm") {
    // A record, not the prose note below. `renderNote` would put a
    // chalk-coloured English sentence at the head of a record stream, and
    // it carries the one fact the bundle records do not: when this snapshot
    // was taken. `classification=current` says it was fresh when it was
    // saved, not when that was.
    printLlmLines([llmLine("resumed", { id: saved.id, saved_at: saved.savedAt })]);
    renderBundle(saved.bundle, format);
    return;
  }
  renderNote(`Resumed investigation "${saved.id}" saved ${saved.savedAt}`);
  renderBundle(saved.bundle, format);
}
