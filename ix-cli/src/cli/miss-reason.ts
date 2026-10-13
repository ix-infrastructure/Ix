// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IxClient } from "../client/api.js";
import { currentRunSignal } from "../client/run-signal.js";
import { resolveWorkspaceRoot } from "./config.js";
import { isFileStale } from "./stale.js";

const execFileAsync = promisify(execFile);

/** Files whose graph state is looked up; each costs one search. */
const FILES_CHECKED = 3;

/** `IX_MISS_PROBE=0` skips the probe (a tree too large for even one bounded rg). */
export const MISS_PROBE_ENV = "IX_MISS_PROBE";

function normalizeForPathMatch(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

export interface SymbolMissReason {
  /**
   * `symbol_file_not_indexed`  the name is in a file the graph does not have
   * `symbol_not_extracted`     the name is in indexed files, as no entity
   * `symbol_not_in_source`     the name is in no file of the workspace either
   */
  reason: "symbol_file_not_indexed" | "symbol_not_extracted" | "symbol_not_in_source";
  message: string;
  /** Workspace-relative files the name appears in (at most three). */
  files?: string[];
}

/**
 * Why a symbol that resolved to nothing is not in the graph, when the
 * workspace's text can say.
 *
 * "No entity found" alone sends an agent to grep, which either finds the name
 * (and the agent concludes Ix is broken) or does not (and it wasted a call).
 * One bounded `rg -l` answers which of those it is before the agent asks: the
 * name is in a file the graph never indexed, in an indexed file as something
 * the parser does not extract, or nowhere at all.
 *
 * Best effort: no ripgrep, a timeout, or a failed search is `null`, and the
 * miss is reported as it always was.
 */
export async function explainSymbolMiss(
  client: Pick<IxClient, "search">,
  symbol: string,
  scope: { path?: string; workspaceId?: string; systemId?: string },
): Promise<SymbolMissReason | null> {
  if (process.env[MISS_PROBE_ENV] === "0") return null;
  // The last segment of `Class.method` / `pkg::name`: that is the token in the text.
  const name = symbol.split(/::|[.#]/).filter(Boolean).pop() ?? "";
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

  let root: string;
  try { root = resolveWorkspaceRoot(); } catch { return null; }

  const files = await filesMentioning(name, root, scope.path);
  if (files === null) return null;
  if (files.length === 0) {
    return {
      reason: "symbol_not_in_source",
      message: `No entity found matching "${symbol}", and "${name}" does not appear in any file under ${scope.path ? `paths matching "${scope.path}"` : "the workspace"} either.`,
    };
  }

  const checked = files.slice(0, FILES_CHECKED);
  const indexed: Array<{ file: string; rev?: number; stale: boolean }> = [];
  for (const file of checked) {
    const node = await graphFile(client, file, scope);
    if (node === undefined) return null;
    if (node === null) {
      return {
        reason: "symbol_file_not_indexed",
        message: `"${symbol}" is not in the graph, but it appears in ${file}, which has not been indexed: ` +
          "run `ix map`, or the file is ignored or of a type Ix does not parse.",
        files: checked,
      };
    }
    let stale = false;
    try { stale = isFileStale(path.join(root, file)); } catch { /* unknown is not stale */ }
    indexed.push({ file, rev: revOf(node), stale });
  }

  const first = indexed[0];
  const where = `${first.file}${first.rev !== undefined ? ` (indexed at rev ${first.rev})` : " (indexed)"}`;
  const more = files.length > 1 ? ` and ${files.length - 1} other file${files.length === 2 ? "" : "s"}` : "";
  const stale = indexed.find((f) => f.stale);
  return {
    reason: "symbol_not_extracted",
    message: `"${symbol}" is not in the graph. It appears in ${where}${more}, but no entity by that name was extracted: ` +
      (stale
        ? `${stale.file} changed after it was indexed, so run \`ix map\` and retry.`
        : "it may be a local, a string, or a construct the parser does not index; `ix text` finds the occurrences."),
    files: checked,
  };
}

/** Workspace-relative files containing `name` as a word, sorted; null when rg could not answer. */
async function filesMentioning(name: string, root: string, pathFilter?: string): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("rg", ["-l", "-F", "-w", "-e", name, "--", root], {
      maxBuffer: 1024 * 1024, timeout: 5_000, signal: currentRunSignal(),
    }));
  } catch (err) {
    const failure = err as { code?: unknown; stdout?: string };
    // rg exits 1 for "no matches": that is an answer.
    if (failure.code === 1 && !failure.stdout) return [];
    return null;
  }
  const filter = pathFilter ? normalizeForPathMatch(pathFilter) : "";
  return stdout.split("\n")
    .filter(Boolean)
    .map((abs) => path.relative(root, abs).split(path.sep).join("/"))
    .filter((rel) => !filter || normalizeForPathMatch(rel).includes(filter))
    .sort();
}

const FILE_SEARCH_LIMIT = 50;

/**
 * The graph's node for a workspace-relative file: null when the graph has
 * none, undefined when that cannot be told (the search failed, or its window
 * came back full without the file -- a basename shared by more files than the
 * window holds proves nothing about this one).
 *
 * The path goes to the backend as `scope`, applied before the limit, so the
 * window holds only files at that path. A backend too old to know `scope`
 * ignores it, and the full-window rule above keeps the answer honest there.
 */
async function graphFile(
  client: Pick<IxClient, "search">,
  file: string,
  scope: { workspaceId?: string; systemId?: string },
): Promise<any | null | undefined> {
  try {
    const nodes = await client.search(path.posix.basename(file), {
      limit: FILE_SEARCH_LIMIT, kind: "file", nameOnly: true, scope: file,
      workspaceId: scope.workspaceId, systemId: scope.systemId,
    });
    const want = normalizeForPathMatch(file);
    const found = (nodes as any[]).find((n) => {
      const uri = normalizeForPathMatch(n?.provenance?.sourceUri ?? n?.provenance?.source_uri ?? "");
      return uri === want || uri.endsWith(`/${want}`);
    });
    if (found) return found;
    return nodes.length >= FILE_SEARCH_LIMIT ? undefined : null;
  } catch {
    return undefined;
  }
}

function revOf(node: any): number | undefined {
  const rev = node?.createdRev ?? node?.created_rev ?? node?.rev;
  return typeof rev === "number" ? rev : undefined;
}
