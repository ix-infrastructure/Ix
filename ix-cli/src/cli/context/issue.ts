// Copyright 2026 Ix Infrastructure Inc.

// `ix context --from-issue`: plan an issue's starting points, build its bundle
// section, and the `--lean` view.

import type { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import type { GraphNode } from "../../client/types.js";
import { resolveWorkspaceRoot } from "../config.js";
import { collectFacts, type ContextFacts, type EntityLocation } from "../explain/facts.js";
import {
  CENTRE_FALLBACK_TRIES,
  chooseCentre,
  leanIssueView,
  planIssue,
  rankIssueFiles,
  readIssueText,
  type Closeness,
  type IssuePlan,
  type LeanIssueView,
  type UsedIn,
  type RankedFile,
  type StartingPoint,
  type SymbolHit,
} from "../explain/issue.js";
import { addUsedIn } from "../explain/issue-used-in.js";
import { collectIssueEntities } from "../explain/issue-entities.js";
import { collectRelatedFiles, type RelatedRef } from "../explain/related-files.js";
import { cachedBm25Ranker } from "../explain/bm25-cache.js";
import { companionHistory, expandIssueCompanions } from "../explain/issue-companions.js";
import { gitRepoAccess, type RepoAccess } from "../explain/text-references.js";
import { llmLine, printLlmLines } from "../llm.js";
import { activeReadScope, ensureReadScope } from "../resolve.js";
import { hasCompletedSourceGraphBaseline } from "../stale.js";
import { reportFailure } from "../ui.js";
import { printJson, relativePath } from "../format.js";
import { checkGraphHealth } from "../graph-health.js";

import { buildBundle } from "./bundle.js";
import { collectContextFacts, findFileNode, bundleGraphHealth } from "./collect.js";
import type { BudgetSnapshot, BundleFormat, ContextOptions } from "./options.js";
import type { ContextBundle, IssueBundleInput } from "./types.js";

/** Search candidates fetched per name the issue mentions; only exact names are kept. */
const ISSUE_SEARCH_LIMIT = 20;

/**
 * `ix context --from-issue`: a bundle built from an issue's text rather than a
 * named target. See `explain/issue.ts` for how starting points are chosen and
 * files ranked.
 *
 * The bundle is centred on the first starting point the graph has a node for,
 * built exactly as `ix context <that target>` would be. The other starting
 * points enter it as entities, with their own related files, and every
 * starting point's neighbourhood feeds the closeness that nudges the ranking.
 * Their facts are collected without text references or git history: those
 * are the expensive, centre-only parts of `collectContextFacts`.
 */
export async function buildIssueBundle(
  arg: string,
  opts: ContextOptions,
  budgets: BudgetSnapshot,
  format: BundleFormat,
): Promise<ContextBundle | undefined> {
  const text = await readIssueOrReport(arg, opts.format);
  if (text === undefined) return undefined;
  const client = createClient({ query: true });
  const plan = await planIssueWith(client, text);
  // A path start has no node yet, and the graph may not have one either: it
  // does not index every tracked file. chooseCentre walks BM25 for one it does.
  const { starts, centre, walked } = await chooseCentre(
    plan.starts, plan.bm25, (path) => findFileNode(client, path), CENTRE_FALLBACK_TRIES, plan.sourcePaths);
  if (!centre) {
    issueFailure(
      "issue_unresolved",
      starts.length === 0
        ? `Nothing the issue names resolved to a definition${plan.unresolved.length > 0 ? ` (tried ${plan.unresolved.slice(0, 5).join(", ")})` : ""}, and no tracked source file matched its text. Name a symbol or file and run ix context <target>.`
        : `Neither the issue's starting points (${starts.map((s) => s.path).join(", ")}) nor the ${CENTRE_FALLBACK_TRIES} source files that best match its text are in the graph. Name a symbol or file and run ix context <target>, or run ix map if this workspace has not been mapped.`,
      opts.format,
    );
    return undefined;
  }
  const resolved = { id: centre.id!, name: centre.name, kind: centre.kind, resolutionMode: "issue" };
  const [facts, context, around, workspaceHealth] = await Promise.all([
    collectContextFacts(client, resolved),
    client.contextForNode(resolved.id, { asOfRev: opts.asOfRev, depth: opts.depth }),
    Promise.all(starts.filter((s) => s.id && s !== centre).map((s) => startNeighbourhood(client, s))),
    checkGraphHealth(client, activeReadScope()),
  ]);

  const issue = await issueBundleSection(client, {
    text, plan, starts, walked,
    neighbourhoods: [{ start: centre, facts, related: facts.relatedRefs ?? [] }, ...around],
    scope: activeReadScope(),
  });

  return buildBundle({
    resolved,
    facts,
    context,
    provenance: facts.provenance,
    asOfRev: opts.asOfRev,
    depth: opts.depth,
    budgets,
    format,
    graphCompleted: hasCompletedSourceGraphBaseline(),
    graphHealth: bundleGraphHealth(workspaceHealth, resolved, facts),
    issue,
  });
}

/** A starting point with its facts and related files, as `--from-issue` loads it. */
interface IssueNeighbourhood {
  start: StartingPoint;
  facts?: ContextFacts;
  related: EntityLocation[];
}

/**
 * The issue section of a `--from-issue` bundle, once the centre's facts and
 * the other starts' neighbourhoods are loaded: closeness and graph distances
 * from those facts, the ranked files, and the definitions listed in the top
 * ones. `neighbourhoods` is the centre's first, then the other starts'.
 */
export async function issueBundleSection(
  client: Pick<IxClient, "listByKind">,
  input: {
    text: string;
    plan: Pick<IssuePlan, "bm25" | "unresolved" | "fallback" | "sourcePaths"> & { repo?: Pick<RepoAccess, "files" | "read"> };
    starts: StartingPoint[];
    walked: boolean;
    neighbourhoods: IssueNeighbourhood[];
    scope: { workspaceId?: string; systemId?: string };
  },
): Promise<IssueBundleInput> {
  const { text, plan, starts, walked, neighbourhoods } = input;
  const near = new Map<string, Closeness>();
  const distances = new Map<string, number>();
  const atDistance = (id: string, distance: number) => {
    distances.set(id, Math.min(distances.get(id) ?? Infinity, distance));
  };
  const mark = (path: string | undefined, weight: number, reason: string) => {
    if (!path) return;
    const prior = near.get(path);
    if (!prior || weight > prior.weight) near.set(path, { weight, reason });
  };
  for (const n of neighbourhoods) {
    atDistance(n.start.id!, 0);
    for (const ref of oneHopRefs(n.facts)) {
      if (ref.path !== n.start.path) mark(ref.path, 1, `one hop from ${n.start.name}`);
    }
    // Neighbour members and text/history-related files do not establish a
    // direct graph edge. Only the facts' direct references fill missing hops.
    for (const ref of [
      ...(n.facts?.importRefs ?? []), ...(n.facts?.calleeRefs ?? []),
      ...(n.facts?.topCallerRefs ?? []), ...(n.facts?.topDependentRefs ?? []),
      ...(n.facts?.memberRefs ?? []),
    ]) atDistance(ref.id, 1);
    for (const ref of n.related) {
      mark(ref.path, 0.5, `near ${n.start.name}`);
    }
  }
  const rankedFiles = await issueRankedFiles(text, { starts, bm25: plan.bm25, near, sourcePaths: plan.sourcePaths }, plan.repo, resolveWorkspaceRoot());
  const candidates = await collectIssueEntities(client, rankedFiles, input.scope);
  // The listing planIssueWith already ran: a second `git ls-files` would only
  // repeat it. Only tracked paths are read, as BM25 read them.
  const repo = plan.repo;
  const tracked = new Set(repo?.files());

  return {
    startingPoints: starts,
    unresolved: plan.unresolved,
    fallback: plan.fallback || walked,
    rankedFiles,
    extraEntities: neighbourhoods.slice(1).flatMap((n) => n.related),
    discoveredEntities: candidates,
    query: text,
    repo: repo ? { read: path => tracked.has(path) ? repo.read(path) : undefined } : undefined,
    distances,
  };
}

/**
 * The full `--from-issue` bundle's ranked files: the primary ranking, whole
 * and in order, then companion files of a leading file (issue-companions.ts)
 * read through `repo` and the git history at `root`. The lean view never
 * calls this: companions are full-bundle only.
 */
export function issueRankedFiles(
  text: string,
  ranking: Parameters<typeof rankIssueFiles>[0],
  repo: Pick<RepoAccess, "files" | "read"> | undefined,
  root: string,
): Promise<RankedFile[]> {
  return expandIssueCompanions(text, rankIssueFiles(ranking), { repo, history: companionHistory(root) });
}

/** The issue's text, or undefined after reporting why it has none. */
async function readIssueOrReport(arg: string, format: string | undefined): Promise<string | undefined> {
  let text: string;
  try {
    text = await readIssueText(arg);
  } catch (error) {
    issueFailure(
      "issue_unreadable",
      `Cannot read the issue from ${arg === "-" ? "stdin" : `"${arg}"`}: ${(error as Error).message}`,
      format,
    );
    return undefined;
  }
  if (!text.trim()) {
    issueFailure("empty_issue", `The issue ${arg === "-" ? "on stdin" : `in "${arg}"`} is empty.`, format);
    return undefined;
  }
  return text;
}

/**
 * The issue's starting points and lexical ranking, against this workspace's
 * graph, with the repository access they were planned against (undefined
 * outside a git checkout) so a caller does not list the files again.
 */
async function planIssueWith(client: IxClient, text: string) {
  await ensureReadScope(client);
  const scope = activeReadScope();
  const root = resolveWorkspaceRoot();
  const repo = gitRepoAccess(root);
  const plan = await planIssue(text, {
    repo,
    // Through the on-disk term index (bm25-cache.ts): the same ranking, with
    // only the files that differ from HEAD read again. The caller saves the
    // index after printing (saveBm25Index).
    rank: cachedBm25Ranker(root, { deferSave: true }),
    search: async (name) =>
      (await client.search(name, { limit: ISSUE_SEARCH_LIMIT, nameOnly: true, ...scope })).map(symbolHit),
  });
  return { ...plan, repo };
}

/**
 * `ix context --from-issue --lean`: the starting points Ix trusts and the
 * next few files, with no bundle around them. See `leanIssueView` for why.
 * Nothing here needs a centre node, so it is also the cheap path: one search
 * per name the issue mentions, BM25 over the tracked files, and one bounded
 * request for where the first symbols are used (issue-used-in.ts). Companion
 * files (issue-companions.ts) are full-bundle only.
 */
export async function emitLeanIssue(arg: string, opts: ContextOptions): Promise<void> {
  const text = await readIssueOrReport(arg, opts.format);
  if (text === undefined) return;
  const client = createClient({ query: true });
  const view = await addUsedIn(client, leanIssueView(await planIssueWith(client, text)));
  if (opts.format === "json") {
    printJson({ kind: "issue_lean", ...view });
  } else if (opts.format === "llm") {
    printLlmLines(renderLeanIssueLlm(view));
  } else {
    console.log(renderLeanIssueText(view));
  }
}

function spanOf(s: StartingPoint): string {
  return s.lineStart !== undefined ? `${s.path}:${s.lineStart}-${s.lineEnd ?? s.lineStart}` : s.path;
}

/** Why a start was trusted, in the words an agent reads. */
function startWhy(s: StartingPoint): string {
  return s.via === "path in issue" ? "the issue names this file" : `the issue names \`${s.token}\``;
}

/** `a.ts, b.ts (+2 more)`, or `widely (40 files)`. */
function usedInText(u: UsedIn): string {
  if (u.widely) return `widely (${u.total} files)`;
  const more = u.total - u.files.length;
  return `${u.files.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

function usedInLlm(name: string, u: UsedIn): string {
  if (u.widely) return llmLine("used_in", [["name", name], ["widely", "true"], ["total", u.total]]);
  const more = u.total - u.files.length;
  return llmLine("used_in", [
    ["name", name], ["files", u.files.join(",")],
    ...(more > 0 ? [["more", more] as [string, number]] : []),
    ["total", u.total],
  ]);
}

export function renderLeanIssueText(view: LeanIssueView): string {
  if (view.confidence === "low") {
    return `Ix found no confident starting point for this issue: ${view.reason}.`;
  }
  const lines = ["Where to start (Ix resolved these from the issue's own words):"];
  for (const s of view.startingPoints) {
    lines.push(`  ${spanOf(s)}  ${s.kind === "file" ? "" : `${s.name} (${s.kind}) — `}${startWhy(s)}`);
    if (s.usedIn) lines.push(`    used in: ${usedInText(s.usedIn)}`);
  }
  if (view.alsoRanked.length > 0) {
    lines.push(`Then, by the issue's text: ${view.alsoRanked.map((f) => f.path).join(", ")}`);
  }
  return lines.join("\n");
}

export function renderLeanIssueLlm(view: LeanIssueView): string[] {
  const out = [llmLine("issue", [
    ["confidence", view.confidence],
    ...(view.reason ? [["reason", view.reason] as [string, string]] : []),
  ])];
  for (const s of view.startingPoints) {
    out.push(llmLine("start", [
      ["path", s.path],
      ...(s.lineStart !== undefined ? [["lines", `${s.lineStart}-${s.lineEnd ?? s.lineStart}`] as [string, string]] : []),
      ["name", s.name], ["kind", s.kind], ["why", startWhy(s)],
    ]));
    if (s.usedIn) out.push(usedInLlm(s.name, s.usedIn));
  }
  for (const f of view.alsoRanked) out.push(llmLine("ranked", [["path", f.path]]));
  return out;
}

/**
 * A `--from-issue` failure, readable by the format asked for. `reportFailure`
 * writes nothing to stdout under `--format json`, so a JSON caller got an empty
 * stdout and had to scrape stderr; this prints the record the other commands'
 * JSON failures use.
 */
function issueFailure(code: string, message: string, format: string | undefined): void {
  if (format === "json") {
    printJson({ error: code, message });
    process.exitCode = 1;
    return;
  }
  reportFailure(code, message, format);
}

/** A secondary starting point's one-hop facts and related files. Best-effort. */
async function startNeighbourhood(
  client: IxClient,
  start: StartingPoint,
): Promise<{ start: StartingPoint; facts?: ContextFacts; related: RelatedRef[] }> {
  try {
    const facts = await collectFacts(client, start.id!, start.name, start.kind, "context");
    const related = await collectRelatedFiles(client, { id: start.id!, kind: start.kind }, facts).catch(() => []);
    return { start, facts, related };
  } catch {
    return { start, related: [] };
  }
}

/** What a target reaches, and what reaches it, one step out. */
function oneHopRefs(facts: ContextFacts | undefined): EntityLocation[] {
  if (!facts) return [];
  return [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []),
  ];
}

/** A search result as the starting-point picker reads it. */
function symbolHit(node: GraphNode): SymbolHit {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const line = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const lineStart = line(attrs.line_start);
  const lineEnd = line(attrs.line_end);
  return {
    id: node.id,
    name: node.name || (typeof attrs.name === "string" ? attrs.name : ""),
    kind: node.kind || "unknown",
    path: relativePath(node.provenance?.sourceUri),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
  };
}
