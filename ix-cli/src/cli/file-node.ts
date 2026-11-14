// Copyright 2026 Ix Infrastructure Inc.

/**
 * The CLI's one lookup of a file's graph node. `ix around` and `ix context`
 * both use it. Two other file searches are deliberately not this lookup:
 * - `tryFileGraphMatch` (resolve.ts) ranks the files a user's target might
 *   mean, fuzzily, and reports ambiguity.
 * - `graphFile` (miss-reason.ts) answers yes / no / cannot tell (a full search
 *   window without the file proves nothing), which a miss diagnosis needs and
 *   a caller that only wants the node does not.
 */

import { posix } from "node:path";

import type { IxClient } from "../client/api.js";
import type { GraphNode } from "../client/types.js";
import { FILE_KINDS } from "./graph-model.js";
import { relativePath } from "./output/rows.js";

/**
 * Search candidates for one file node. `scope` narrows the search to the path
 * on a backend that applies it (Ix-memory >= 1.0.31); an older one ignores it
 * and returns every file sharing the basename, so the limit has to reach past
 * a monorepo's `index.ts`, `__init__.py` or `mod.rs` -- at 10 a file ranked
 * eleventh among its namesakes had no node, and `--from-issue` discarded a path
 * the issue named for a BM25 guess. The headroom exists for backends that
 * ignore `scope`, so it can shrink once MIN_BACKEND_VERSION reaches 1.0.31
 * (`searchScope` in client/features.ts).
 */
const FILE_NODE_SEARCH_LIMIT = 200;

/**
 * A node's file path as the graph holds it, `/`-separated, case kept; either
 * provenance spelling. `ix around` reads the matched node's path with it too.
 */
export function fileUri(n: Partial<GraphNode> | undefined): string {
  return String(n?.provenance?.sourceUri ?? n?.provenance?.source_uri ?? "").replace(/\\/g, "/");
}

export interface FindFileNodeOptions {
  /** The read scope to search in: `activeReadScope()` from resolve.ts. */
  scope: { workspaceId?: string; systemId?: string };
  /**
   * Also accept one file whose path ends in the asked-for path (or is a suffix
   * of it) on a `/` boundary, when no path is equal. Off by default: a caller
   * that pairs the node with the path it asked for (`ix context`) must not get
   * another directory's namesake. `ix around` turns it on: its path comes from
   * an editor or hook and may be rooted differently from the graph's paths.
   * Two or more suffix matches are a guess, so they find nothing.
   */
  suffixMatch?: boolean;
}

/**
 * The graph's file node for a workspace-relative path, or undefined when the
 * graph has no node for it. A path matches when it equals the node's path, or
 * that path made workspace-relative (a legacy absolute path under the cwd).
 * A failed search rejects; callers that can do without the node catch it.
 */
export async function findFileNode(
  client: Pick<IxClient, "search">,
  relPath: string,
  opts: FindFileNodeOptions,
): Promise<GraphNode | undefined> {
  const want = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const { workspaceId, systemId } = opts.scope;
  const nodes = await client.search(posix.basename(want), {
    kind: "file", nameOnly: true, limit: FILE_NODE_SEARCH_LIMIT, scope: want, workspaceId, systemId,
  });
  const files = nodes.filter((n) => FILE_KINDS.has(String(n?.kind).toLowerCase()));
  const exact = files.find((n) => {
    const uri = fileUri(n);
    return uri === want || relativePath(uri) === want;
  });
  if (exact || !opts.suffixMatch) return exact;
  const suffix = files.filter((n) => {
    const uri = fileUri(n);
    return uri !== "" && (uri.endsWith(`/${want}`) || want.endsWith(`/${uri}`));
  });
  return suffix.length === 1 ? suffix[0] : undefined;
}
