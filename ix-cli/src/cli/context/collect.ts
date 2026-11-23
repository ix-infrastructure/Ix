// Copyright 2026 Ix Infrastructure Inc.

// Graph reads behind a bundle that are not the `/v1/context` call itself:
// structural facts, history, text references and graph health.

import type { IxClient } from "../../client/api.js";
import { resolveWorkspaceRoot } from "../config.js";
import { collectFacts, type ContextFacts } from "../explain/facts.js";
import { collectRelatedFiles, MAX_RELATED, type RelatedRef } from "../explain/related-files.js";
import { collectTextReferences, gitRepoAccess, type TextSource } from "../explain/text-references.js";
import { coChangedFiles, gitRunner, recentCommits, type CommitRef } from "../explain/history.js";
import { activeReadScope } from "../resolve.js";
import { findFileNode } from "../file-node.js";
import { assessTargetStructure, worseHealth, type GraphHealth } from "../graph-health.js";

/**
 * The facts a bundle is built from: one hop from `collectFacts`, then the
 * ranked files two hops out, which are seeded from those facts. The second
 * step is best-effort -- a bundle without it is the bundle `ix context` built
 * before it existed, and failing the command over it would be a regression.
 */
export async function collectContextFacts(
  client: IxClient,
  resolved: { id: string; name: string; kind: string },
): Promise<ContextFacts> {
  const facts = await collectFacts(client, resolved.id, resolved.name, resolved.kind, "context");
  const graphRefs = await collectRelatedFiles(client, resolved, facts).catch(() => []);
  const textRefs = await collectTextRelated(client, facts, graphRefs).catch(() => []);
  const history = await collectHistory(client, facts, [...graphRefs, ...textRefs]).catch(() => undefined);
  // Added to the graph's files, not ranked against them. Put first and sharing
  // the eight slots, they displaced graph finds the benchmark needed
  // (`main.ts` for `mcp/runner.ts`) with mentions that led nowhere.
  const relatedRefs = [...graphRefs.slice(0, MAX_RELATED), ...textRefs, ...(history?.coChanged ?? [])];
  return {
    ...facts,
    ...(relatedRefs.length > 0 ? { relatedRefs } : {}),
    ...(history?.recent.length ? { recentCommits: history.recent } : {}),
  };
}

/**
 * The target file's recent commits, and the files that changed with it. From
 * the working tree's git, so absent outside a checkout. See `explain/history.ts`.
 */
async function collectHistory(
  client: IxClient,
  facts: ContextFacts,
  related: RelatedRef[],
): Promise<{ recent: CommitRef[]; coChanged: RelatedRef[] } | undefined> {
  if (!facts.path) return undefined;
  const git = gitRunner(resolveWorkspaceRoot());
  const known = new Set<string>([facts.path]);
  for (const ref of [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.memberCalleeRefs ?? []),
    ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []), ...related,
  ]) {
    if (ref.path) known.add(ref.path);
  }
  const [recent, coChanges] = await Promise.all([recentCommits(git, facts.path), coChangedFiles(git, facts.path, known)]);
  const coChanged = await Promise.all(coChanges.map(async (c) => {
    const name = c.path.split("/").pop()!;
    const id = await fileNodeId(client, c.path);
    const named = `changed with the target in ${c.commits} commits`;
    return { id, name, kind: "file", path: c.path, score: c.score, reason: named, via: [], named };
  }));
  return { recent, coChanged };
}

/**
 * A file's graph node id, for an entity the rest of the bundle can refer to.
 * Scoped: a backend holding two checkouts of one repository has two. Falls
 * back to a synthetic id rather than dropping a file the graph has not seen.
 */
async function fileNodeId(client: IxClient, path: string): Promise<string> {
  return (await fileNodeIdOrUndefined(client, path)) ?? `file:${path}`;
}

/**
 * A file's graph node id, or undefined when the graph has no node for it or
 * the search failed. Exact paths only: the id is paired with this path.
 */
export async function fileNodeIdOrUndefined(client: IxClient, path: string): Promise<string | undefined> {
  const node = await findFileNode(client, path, { scope: activeReadScope() }).catch(() => undefined);
  return node?.id;
}

/** Imported files whose text is read for names, after the target's own. */
const TEXT_SOURCE_IMPORTS = 8;

/**
 * Files linked to the target by text rather than by any graph edge: a path in
 * a string (`"../../../../core-ingestion/dist/languages.js"`), a file named
 * in a comment, a test that reads a file by path. Read from the working tree,
 * so skipped outside a git checkout. See `collectTextReferences`.
 */
async function collectTextRelated(
  client: IxClient,
  facts: ContextFacts,
  graphRefs: RelatedRef[],
): Promise<RelatedRef[]> {
  if (!facts.path) return [];
  const repo = gitRepoAccess(resolveWorkspaceRoot());
  if (!repo) return [];
  const sources: TextSource[] = [
    { path: facts.path, role: "target" },
    ...(facts.importRefs ?? [])
      .filter((ref) => ref.kind === "file" && ref.path)
      .slice(0, TEXT_SOURCE_IMPORTS)
      .map((ref) => ({ path: ref.path!, role: "import" as const })),
  ];
  const known = new Set<string>();
  for (const ref of [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.memberCalleeRefs ?? []),
    ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []), ...graphRefs,
  ]) {
    if (ref.path) known.add(ref.path);
  }
  const found = collectTextReferences(repo, sources, known);
  return Promise.all(found.map(async (ref): Promise<RelatedRef> => ({
    id: await fileNodeId(client, ref.path), name: ref.path.split("/").pop()!, kind: "file", path: ref.path,
    score: ref.score, reason: ref.reason, via: [], named: ref.reason,
  })));
}

/**
 * The workspace verdict, made worse by the target's own structure when a
 * definition no file contains shows its edges are gone even though the
 * workspace as a whole looks fine (only some files re-ingested elsewhere).
 */
export function bundleGraphHealth(
  workspace: GraphHealth,
  resolved: { name: string; kind: string },
  facts: { path?: string; container?: unknown },
): GraphHealth {
  return worseHealth(workspace, assessTargetStructure({
    name: resolved.name, kind: resolved.kind, path: facts.path, container: facts.container,
  }));
}
