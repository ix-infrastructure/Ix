// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ixHome } from "./ix-home.js";

/**
 * The `-` shorthand of `ix note` / `ix session`: "the note (or session) I
 * last created or showed".
 *
 * Kept in `<IX_HOME>/recent.json`, in the format Ix Pro uses for the same
 * commands: `{ "<kind>": { "<org>": "<id>" } }`. Pro keys by the active cloud
 * org; the local backend has none, so this keys by `local` and the two never
 * answer for each other.
 */
export type RecentKind = "note" | "session";

const LOCAL_KEY = "local";

function recentFile(): string {
  return join(ixHome(), "recent.json");
}

function loadRecent(): Record<string, Record<string, string>> {
  try {
    const data = JSON.parse(readFileSync(recentFile(), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Remember `id` as the last one of `kind`. Best-effort: a write failure never fails the command. */
export function rememberRecent(kind: RecentKind, id: string): void {
  const data = loadRecent();
  const byOrg = data[kind] && typeof data[kind] === "object" ? data[kind] : {};
  data[kind] = { ...byOrg, [LOCAL_KEY]: id };
  try {
    mkdirSync(ixHome(), { recursive: true, mode: 0o700 });
    writeFileSync(recentFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Read-only home, full disk: the shorthand is a convenience.
  }
}

/**
 * `-` → the remembered id of `kind`; anything else unchanged. Throws when `-`
 * has nothing to resolve to, rather than sending "-" to the backend and
 * reporting "note '-' not found".
 */
export function resolveRecent(kind: RecentKind, idOrDash: string): string {
  if (idOrDash !== "-") return idOrDash;
  const remembered = loadRecent()[kind]?.[LOCAL_KEY];
  if (typeof remembered !== "string" || !remembered) {
    throw new Error(`No recent ${kind} to resolve "-" against. Run \`ix ${kind} show <id>\` first.`);
  }
  return remembered;
}
