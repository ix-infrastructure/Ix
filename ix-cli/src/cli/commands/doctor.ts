// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { renderSection, renderSuccess, renderError } from "../ui.js";
import { createClient } from "../../client/factory.js";
import { IxClient } from "../../client/api.js";
import {
  canonicalWorkspacePath,
  ConfigParseError,
  DEFAULT_ENDPOINT,
  findWorkspaceForCwd,
  getDefaultWorkspace,
  getEndpoint,
  gitRootFor,
  loadConfig,
  loadWorkspaces,
  selectWorkspaceForCwd,
  type WorkspaceConfig,
} from "../config.js";
import { ixHome } from "../ix-home.js";
import { isLocalEndpoint } from "../backend-version.js";
import { resolveReadSystemId } from "../resolve.js";
import { assessGraphStats } from "../graph-health.js";
import { llmLine, printLlmLines } from "../llm.js";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { join as pathJoin, resolve as resolvePath, win32 as winPath } from "node:path";
import { homedir } from "node:os";
import {
  BACKEND_IMAGE,
  checkBackendImage,
  checkBackendSchema,
  isNonStandardBackend,
  dockerAvailable,
  diagnoseBackendStack,
} from "../backend-status.js";
import { backendCeiling, isNewer, readBackendHealth } from "./upgrade.js";
import { loadIngestBaseline } from "../ingest-baseline.js";
import { isCloudReady } from "../remote.js";
import { hasCompletedMapBaseline } from "../stale.js";
import { printJson } from "../format.js";
import type { CapabilitiesResponse, HealthResponse } from "../../client/types.js";

interface CheckResult {
  ok: boolean;
  detail: string;
  // A warning is surfaced (yellow) but does not fail the overall run — e.g. an
  // intentional local dev backend, or an inconclusive image comparison.
  warn?: boolean;
}

/**
 * `ix doctor --format llm`.
 *
 * `text` renders a ✓/!/✗ glyph per check and then, on failure, the singularly
 * unhelpful "Run with --format json for details" — the details were already in
 * hand, they were just not printed. Every check's status and detail is emitted
 * here, so an agent never has to make a second call to find out what broke.
 *
 * Status is a word rather than a symbol because `ok`/`warn`/`fail` survives
 * being read back by something that is not a terminal.
 */
export function renderDoctorLlm(
  results: Array<{ name: string } & CheckResult>,
  hasFailure: boolean,
  hasWarning: boolean,
): string[] {
  const lines = [llmLine("doctor", [
    ["healthy", hasFailure ? "false" : "true"],
    ["warnings", hasWarning ? "true" : "false"],
    ["checks", String(results.length)],
  ])];
  for (const r of results) {
    lines.push(llmLine("check", [
      ["name", r.name],
      // Same precedence as the glyphs and as `hasFailure` below: a warning is
      // `{ ok: false, warn: true }`, so `warn` has to be checked on the
      // not-ok branch. Testing it on the ok branch reports every warning as a
      // hard failure, which is the opposite of what `hasFailure` concludes.
      ["status", r.ok ? "ok" : r.warn ? "warn" : "fail"],
      ["detail", r.detail],
    ]));
  }
  return lines;
}

interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

/**
 * Does `%IX_HOME%\bin\ix.cmd` still point at a CLI that exists?
 *
 * `ix upgrade` before 0.9.0 refreshed only the bash shim and left this launcher
 * aimed at a `cli\ix.cmd` the upgrade had just replaced with a version-nested
 * directory (Ix#385).
 *
 * The obvious objection is that a user whose launcher is broken cannot run
 * `ix doctor` to be told so. True from PowerShell — which is why the launcher
 * now diagnoses itself. This check covers the case that shim cannot: the *bash*
 * shim under Git Bash / MSYS is refreshed by every version, so `ix` keeps
 * working there while the native launcher is quietly dead. Someone who lives in
 * Git Bash can be broken in PowerShell for weeks without knowing.
 */
export function checkWindowsLauncher(
  ixHome: string,
  readShim: (path: string) => string | null,
  exists: (path: string) => boolean,
): CheckResult {
  const shimPath = pathJoin(ixHome, "bin", "ix.cmd");
  const body = readShim(shimPath);
  if (body === null) {
    return { ok: true, detail: "no ix.cmd launcher (not installed by install.ps1)" };
  }

  // The launcher invokes its target as the first quoted %~dp0-relative path.
  const target = body.match(/"(%~dp0[^"]+)"/)?.[1];
  if (!target) {
    return { ok: true, warn: true, detail: `${shimPath}: unrecognized launcher, left alone` };
  }

  // %~dp0 is the directory of ix.cmd itself — IX_HOME\bin — and the target is
  // written with backslashes. Resolve with win32 semantics explicitly rather
  // than the ambient `path`, so the separator handling does not depend on which
  // OS happens to be evaluating it. (Production only reaches here on Windows,
  // but a resolver that silently misreads its input off-Windows is untestable.)
  const resolved = winPath.join(ixHome, "bin", target.replace(/^%~dp0/, ""));
  if (exists(resolved)) return { ok: true, detail: `ix.cmd → ${target}` };

  return {
    ok: false,
    detail:
      `${shimPath} points at ${target}, which does not exist — ` +
      "an upgrade from before 0.9.0 moved the CLI. Reinstall to repair: " +
      "irm https://ix-infra.com/install.ps1 | iex",
  };
}

/** A registered workspace sitting inside another one. */
export interface NestedWorkspace {
  nested: WorkspaceConfig;
  parent: WorkspaceConfig;
}

/**
 * Registered workspaces nested inside another registered workspace whose own
 * root is not a git root.
 *
 * Before `ix ingest <path>` looked for the workspace a path belongs to, it
 * registered the path itself (or a file's directory) as a new workspace: `ix
 * ingest src/a.ts` in a mapped repo left a `repo/src` workspace holding one
 * file, and every read under `src/` resolved to it from then on. A nested
 * workspace that is its own git root is the legitimate shape -- a member repo
 * of a multi-repo system mapped on its own -- and is not reported.
 *
 * `isGitRoot` is injected so the rule can be tested without spawning git.
 */
export function findStrayNestedWorkspaces(
  workspaces: WorkspaceConfig[],
  isGitRoot: (root: string) => boolean,
): NestedWorkspace[] {
  const found: NestedWorkspace[] = [];
  for (const ws of workspaces) {
    const root = canonicalWorkspacePath(ws.root_path);
    const others = workspaces.filter(o => o !== ws && canonicalWorkspacePath(o.root_path) !== root);
    const parent = selectWorkspaceForCwd(others, root);
    if (parent && !isGitRoot(root)) found.push({ nested: ws, parent });
  }
  return found;
}

/** Whether `dir` is the top level of a git working tree. */
export function isGitTopLevel(dir: string): boolean {
  const top = gitRootFor(dir);
  return top !== undefined && canonicalWorkspacePath(top) === canonicalWorkspacePath(dir);
}

/**
 * The doctor check over {@link findStrayNestedWorkspaces}. Read-only: it names
 * the repair and leaves the deleting to the user. There is no command that
 * unregisters a workspace, so the repair is the scoped graph reset (run from
 * inside the stray workspace, which `ix reset --workspace` resolves to because
 * the nearest registration wins) and then removing its entry by hand.
 */
export function checkNestedWorkspaces(
  workspaces: WorkspaceConfig[],
  isGitRoot: (root: string) => boolean,
  configPath: string,
): CheckResult {
  const stray = findStrayNestedWorkspaces(workspaces, isGitRoot);
  if (stray.length === 0) return { ok: true, detail: "no stray workspace registered inside another" };
  const lines = stray.map(({ nested, parent }) =>
    `'${nested.workspace_name}' (${nested.root_path}) is inside '${parent.workspace_name}' (${parent.root_path}) ` +
    `and is not a git root, so reads under it resolve to it instead of '${parent.workspace_name}'. ` +
    `Fix: cd "${nested.root_path}" && ix reset --workspace --yes, ` +
    `then delete its entry (root_path: ${nested.root_path}) from ${configPath}`,
  );
  return {
    ok: false,
    warn: true,
    detail:
      `${stray.length} workspace(s) registered inside another, most likely left by \`ix ingest <path>\` ` +
      `on a path below a mapped workspace, which older versions registered as a workspace of its own:\n  ` +
      lines.join("\n  "),
  };
}

/**
 * Does the backend require the local bearer token, and does this CLI have the
 * one it accepts? `caps` is the `/v1/capabilities` answer, or the error asking
 * for it threw. A refused token fails the run, because every command fails the
 * same way; a token the backend ignores is only a warning.
 */
export function assessLocalAuth(
  caps: CapabilitiesResponse | Error,
  sendsToken: boolean,
  local: boolean,
): CheckResult {
  if (caps instanceof Error && caps.name === "LocalTokenRequiredError") {
    return {
      ok: false,
      detail: sendsToken
        ? "the backend refused this CLI's token — " +
          (local ? "run 'ix docker start --local-token' to give the backend the stored one" : "check IX_TOKEN")
        : "the backend requires a token and this CLI has none — " +
          (local ? "run 'ix docker start --local-token', or set IX_TOKEN" : "set IX_TOKEN"),
    };
  }
  if (caps instanceof Error) return { ok: true, detail: "backend unreachable (skipped)" };
  if (caps.local_auth === undefined) return { ok: true, detail: "backend predates the token guard (skipped)" };
  if (caps.local_auth_enforcing) return { ok: true, detail: "required, and this CLI's token is accepted" };
  if (sendsToken) {
    return {
      ok: false, warn: true,
      detail: "this CLI has a token but the backend does not require it — " +
        (local ? "run 'ix docker start --local-token' to apply it" : "the backend ignores it"),
    };
  }
  return {
    ok: true,
    detail: local ? "not required (opt in with 'ix docker start --local-token')" : "not required",
  };
}

/**
 * A health answer, including the 503 a backend sends while it cannot reach its
 * database: that is a server that answered, and the body says what is wrong.
 * Thrown for anything else.
 */
export function healthFromError(err: unknown): HealthResponse | null {
  const m = /^503:\s*(\{.*\})\s*$/s.exec((err as Error)?.message ?? "");
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]!) as HealthResponse;
    return typeof body?.status === "string" ? body : null;
  } catch {
    return null;
  }
}

/**
 * "Database reachable" from the health answer. A backend that reports
 * `database` says so itself; an older one never touched the database for
 * health, so `probe` asks a route that does (`/v1/revisions/current`).
 */
export async function assessDatabase(
  health: HealthResponse | Error,
  probe: () => Promise<unknown>,
): Promise<CheckResult> {
  if (health instanceof Error) return { ok: true, detail: "backend unreachable (skipped)" };
  if (health.database === "reachable") return { ok: true, detail: "reachable (backend health)" };
  if (health.database === "unreachable") {
    return { ok: false, detail: "the memory layer cannot reach ArangoDB — check 'ix docker status' and 'ix docker logs'" };
  }
  try {
    await probe();
    return { ok: true, detail: "reachable (read the current revision)" };
  } catch (e) {
    // The read was refused for want of the token, so it says nothing about the
    // database; "Backend token" reports the refusal.
    if ((e as Error)?.name === "LocalTokenRequiredError") {
      return { ok: true, detail: "not checked: the backend refused this CLI's token (see Backend token)" };
    }
    const msg = (e as Error)?.message ?? String(e);
    return { ok: false, detail: `the backend could not read its database: ${msg.slice(0, 200)}` };
  }
}

/** What every other command does with a config.yaml that does not parse (#807). */
const CONFIG_REFUSAL = "other ix commands refuse to run until it is fixed";

/**
 * "Config file parses". A config.yaml that does not parse stops every other
 * command (`loadConfig` throws ConfigParseError), so this is a failure, and the
 * one doctor is still able to report: it catches that error itself.
 */
export function assessConfigFile(configPath: string, read: (p: string) => string | null): CheckResult {
  const raw = read(configPath);
  if (raw === null) return { ok: true, detail: "no config file (defaults)" };
  try {
    const parsed = parseYaml(raw);
    if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
      return { ok: false, detail: `${configPath} is not a mapping of settings, so ${CONFIG_REFUSAL}` };
    }
    return { ok: true, detail: configPath };
  } catch (e) {
    const first = ((e as Error)?.message ?? String(e)).split("\n")[0];
    return { ok: false, detail: `${configPath} does not parse, so ${CONFIG_REFUSAL}: ${first}` };
  }
}

/** The answer of a check that needs config.yaml when config.yaml does not parse. */
const CONFIG_NOT_CHECKED: CheckResult = { ok: true, detail: "not checked: config.yaml does not parse" };

function isConfigParseError(e: unknown): e is ConfigParseError {
  return (e as Error | undefined)?.name === "ConfigParseError";
}

/**
 * The endpoint and client doctor checks with. A config.yaml that does not parse
 * is the one failure doctor must survive, since reporting it is its job: the
 * endpoint falls back to IX_ENDPOINT or the default, and the client is built
 * without the stored token, which lives in the file that does not parse.
 */
function doctorClient(): { endpoint: string; client: IxClient } {
  let endpoint: string;
  try {
    endpoint = getEndpoint();
  } catch (e) {
    if (!isConfigParseError(e)) throw e;
    endpoint = process.env.IX_ENDPOINT || DEFAULT_ENDPOINT;
  }
  try {
    return { endpoint, client: createClient({ endpoint }) };
  } catch (e) {
    if (!isConfigParseError(e)) throw e;
    // createClient read the stored token from the file that does not parse.
    const token = process.env.IX_TOKEN?.trim();
    // eslint-disable-next-line no-restricted-syntax -- the factory cannot build a client without config.yaml
    return { endpoint, client: new IxClient(endpoint, undefined, token ? { token } : {}) };
  }
}

/** A workspace lookup, or none when config.yaml (where workspaces live) does not parse. */
function workspaceOrNone(lookup: () => WorkspaceConfig | undefined): WorkspaceConfig | undefined {
  try {
    return lookup();
  } catch (e) {
    if (isConfigParseError(e)) return undefined;
    throw e;
  }
}

/** "ripgrep on PATH": `ix text` needs it; everything else works without it. */
export function checkRipgrep(run: () => string = () => execFileSync("rg", ["--version"], { encoding: "utf-8", timeout: 5000 })): CheckResult {
  try {
    const first = run().split("\n")[0]?.trim();
    return { ok: true, detail: first || "rg found" };
  } catch {
    return { ok: false, warn: true, detail: "rg not found on PATH — 'ix text' needs ripgrep" };
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Ix system health — server, database, graph integrity")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { format: string }) => {
      const { endpoint, client } = doctorClient();
      // Asked of the file directly: with IX_ENDPOINT and IX_TOKEN set,
      // building the client never reads it.
      let configBroken = false;
      try { loadConfig(); } catch (e) {
        if (!isConfigParseError(e)) throw e;
        configBroken = true;
      }

      // "Graph has nodes" and "Graph has edges" are two questions about one
      // response. They were two `client.stats()` calls, run back to back by the
      // sequential loop below — and `/v1/stats` is 3-4 s on a large graph, so
      // the second one was most of what `ix doctor` spent. Memoized rather than
      // hoisted so a run that never reaches those checks still never asks, and
      // so a failure is still reported per check rather than aborting both.
      // Counting only the active scope makes the number correct and, on its own,
      // less self-evident: "0 nodes" against a backend holding thousands reads
      // as a broken install until it says whose nodes it counted. The scope
      // travels with the count so the check explains itself.
      // Resolved here rather than through `resolveWorkspaceId()`, which answers a
      // directory that matches no workspace by substituting whichever one carries
      // `default: true`. That collapses two states doctor has to tell apart — cwd
      // matched THIS workspace, and cwd matched nothing so here is an unrelated
      // one — into a single id. Reporting the second as "this workspace" is how a
      // never-ingested directory passed every check while quoting another repo's
      // graph (#518). Local, so it still answers when the backend is unreachable.
      const cwd = process.cwd();
      const matchedWorkspace = workspaceOrNone(() => findWorkspaceForCwd(cwd));
      const substitutedWorkspace = matchedWorkspace ? undefined : workspaceOrNone(getDefaultWorkspace);

      let statsOnce: Promise<{ stats: any; scope: string; systemId?: string }> | undefined;
      const sharedStats = (): Promise<{ stats: any; scope: string; systemId?: string }> => (statsOnce ??= (async () => {
        // Without the workspaces there is no scope to count in, and an
        // unscoped count would be reported as if it were this directory's.
        if (configBroken) throw new ConfigParseError(pathJoin(ixHome(), "config.yaml"), "see Config file parses");
        // Scoped the same way `ix stats` scopes, because doctor disagreeing with
        // stats about the size of the graph is the whole of #510. Not a
        // tombstone fix: /v1/stats filters `deleted_rev == null` in every one of
        // its queries, scoped or not, so deleted nodes were never in either
        // count. What the unscoped call added was every *live* node belonging to
        // some other workspace on the same backend, which is how a freshly
        // reset workspace still looked like a 17k-node graph.
        const systemId = await resolveReadSystemId(client, { allowUnmapped: true });
        const workspace = systemId ? undefined : (matchedWorkspace ?? substitutedWorkspace);
        const stats = await client.stats({ workspaceId: workspace?.workspace_id, systemId });
        // Named, not deictic. "this workspace" is only true when cwd actually
        // matched one, and the case where it has not is exactly the case where
        // the reader most needs to know whose count they are being shown.
        // No workspace at all means the request really was unscoped — say that
        // rather than name a scope.
        const scope = systemId
          ? "this system"
          : workspace
            ? `workspace '${workspace.workspace_name}'`
            : "all workspaces";
        return { stats, scope, systemId };
      })());

      // One /v1/health for "Server reachable" and "Database reachable". A 503
      // with a health body is the backend reporting a dead database, so it is
      // an answer, not a failure to reach the server.
      let healthOnce: Promise<HealthResponse> | undefined;
      const health = (): Promise<HealthResponse> => (healthOnce ??= readBackendHealth(client).catch((e: unknown) => {
        const degraded = healthFromError(e);
        if (degraded) return degraded;
        throw e;
      }));

      const checks: Check[] = [
        {
          name: "Server reachable",
          run: async () => {
            try {
              // Records what the backend says it is running; see
              // backend-version.ts. Free — this response is already needed.
              const h = await health();
              // A degraded answer is still a server that answered; the
              // database check below names what is wrong with it.
              return { ok: h.status === "ok" || h.status === "degraded", detail: `${endpoint} → ${h.status}` };
            } catch (e: any) {
              // An unreachable backend is where a fatal Arango boot loop hides:
              // the container restarts forever, memory-layer never leaves
              // `Created` behind `service_healthy`, and from out here that is
              // indistinguishable from "not started yet". Say what the stack
              // actually reported. Ix#614.
              const base = e.message ?? "unreachable";
              const failure = isLocalEndpoint(endpoint) && dockerAvailable() ? diagnoseBackendStack() : null;
              if (!failure) return { ok: false, detail: base };
              const parts = [`${base} — ${failure.service} is ${failure.state}`];
              if (failure.lastError) parts.push(`  last log: ${failure.lastError}`);
              if (failure.remedy) parts.push(`  fix: ${failure.remedy}`);
              return { ok: false, detail: parts.join("\n") };
            }
          },
        },
        {
          name: "Database reachable",
          run: async () => {
            let h: HealthResponse | Error;
            try {
              h = await health();
            } catch (e) {
              h = e instanceof Error ? e : new Error(String(e));
            }
            return assessDatabase(h, () => client.currentRevision());
          },
        },
        {
          name: "Backend token",
          run: async () => {
            let caps: CapabilitiesResponse | Error;
            try {
              caps = await client.fetchCapabilities();
            } catch (e) {
              caps = e instanceof Error ? e : new Error(String(e));
            }
            return assessLocalAuth(caps, client.sendsToken === true, isLocalEndpoint(endpoint));
          },
        },
        {
          name: "Workspace for this directory",
          run: async () => {
            // A system scope supersedes the per-directory workspace, so ask what
            // the read path resolved to before judging cwd. Best-effort: if the
            // backend is unreachable the local answer below is still the right
            // one, and "Server reachable" already reports the outage.
            let systemScoped = false;
            try {
              systemScoped = Boolean((await sharedStats()).systemId);
            } catch { /* fall through to the local answer */ }

            if (systemScoped) return { ok: true, detail: "scoped to the active system" };
            if (configBroken) return CONFIG_NOT_CHECKED;
            if (matchedWorkspace) return { ok: true, detail: `workspace '${matchedWorkspace.workspace_name}'` };
            if (substitutedWorkspace) {
              return {
                ok: false,
                detail:
                  `no workspace registered for ${cwd} — graph reads here fail with workspace_not_mapped ` +
                  `(they no longer fall back to the default workspace '${substitutedWorkspace.workspace_name}'). ` +
                  "Run `ix map` in this directory.",
              };
            }
            // Nothing registered anywhere: honest and self-explanatory, and the
            // graph checks below already fail on the empty count. Warn rather
            // than fail so a fresh install reports one problem, not three.
            // `{ ok: false, warn: true }` is the shape a warning takes — `warn`
            // is read on the not-ok branch, so `ok: true` here would render as a
            // clean pass and say nothing.
            return { ok: false, warn: true, detail: "none registered yet — run `ix map`" };
          },
        },
        {
          name: "No stray nested workspaces",
          run: async () =>
            checkNestedWorkspaces(loadWorkspaces(), isGitTopLevel, pathJoin(ixHome(), "config.yaml")),
        },
        {
          // Ix#525: a partially committed graph still has nodes and edges, so
          // every check below it passes and doctor calls a half-built graph
          // healthy. The completion markers are the only thing that knows.
          //
          // Reads the two marker files rather than calling `detectStaleFiles`:
          // that walks the workspace and stats every file to answer a question
          // about *changed* files, and this check needs neither the walk nor
          // the answer. On a large workspace it is the whole tree per `ix
          // doctor`.
          name: "Completed map for this workspace",
          run: async () => {
            if (configBroken) return CONFIG_NOT_CHECKED;
            if (!matchedWorkspace) {
              return { ok: false, warn: true, detail: "no local workspace to check" };
            }
            try {
              // Resolve once: both marker files are keyed by the exact root
              // string, and `hasCompletedMapBaseline` resolves internally.
              const root = resolvePath(matchedWorkspace.root_path);
              const source = loadIngestBaseline(root);
              if (!source) {
                // No local baseline means one of: never mapped, an initial map
                // that committed patches but never finished, or a workspace fed
                // by the cloud runner — which writes none by design. Only the
                // last is healthy, and only a registered runner makes it
                // possible, so that is the one case this warns instead of fails.
                const cloud = await isCloudReady();
                return cloud
                  ? { ok: false, warn: true, detail: "no local baseline — expected for a cloud-ingested workspace" }
                  : { ok: false, detail: "no completed map baseline — the graph may be partial. Run `ix map`." };
              }
              if (!hasCompletedMapBaseline(root)) {
                return {
                  ok: false,
                  detail: `source graph at revision ${source.currentRev} has no completed architecture map — run \`ix map\``,
                };
              }
              return { ok: true, detail: `recorded at revision ${source.currentRev}` };
            } catch (e: any) {
              return { ok: false, detail: e.message ?? "map completion check failed" };
            }
          },
        },
        {
          name: "Graph has nodes",
          run: async () => {
            try {
              const { stats, scope } = await sharedStats();
              const total = stats.nodes?.total ?? 0;
              return { ok: total > 0, detail: `${total} nodes in ${scope}` };
            } catch (e: any) {
              if (isConfigParseError(e)) return CONFIG_NOT_CHECKED;
              return { ok: false, detail: e.message ?? "stats failed" };
            }
          },
        },
        {
          name: "Graph has edges",
          run: async () => {
            try {
              const { stats, scope } = await sharedStats();
              const total = stats.edges?.total ?? 0;
              return { ok: total > 0, detail: `${total} edges in ${scope}` };
            } catch (e: any) {
              if (isConfigParseError(e)) return CONFIG_NOT_CHECKED;
              return { ok: false, detail: e.message ?? "stats failed" };
            }
          },
        },
        {
          // A graph can keep every node and lose nearly every edge (another
          // checkout's ingest, Ix-memory#211): both counts above stay non-zero
          // and every answer is quietly wrong. Same judgement as the query
          // paths use (graph-health.ts), from the stats already fetched.
          name: "Graph structure intact",
          run: async () => {
            try {
              const { stats, scope } = await sharedStats();
              const health = assessGraphStats(stats);
              if (health.status === "degraded") {
                return { ok: false, detail: `${scope}: ${health.message} Fix: ${health.fix}` };
              }
              if (health.status === "ok") {
                return {
                  ok: true,
                  detail: `${health.structuralEdges} structural edges for ${health.symbols} symbols in ${scope}`,
                };
              }
              // Empty (which "Graph has nodes" already fails) or a stats body
              // without the per-predicate breakdown: nothing to judge by, and
              // not a second failure for one problem.
              return { ok: true, detail: `not judged: no ${health.status === "empty" ? "nodes" : "edge breakdown"} in ${scope}` };
            } catch (e: any) {
              if (isConfigParseError(e)) return CONFIG_NOT_CHECKED;
              return { ok: false, detail: e.message ?? "stats failed" };
            }
          },
        },
        {
          name: "No unresolved conflicts",
          run: async () => {
            try {
              const c = await client.conflicts();
              const count = Array.isArray(c) ? c.length : 0;
              return { ok: count === 0, detail: count === 0 ? "clean" : `${count} conflict(s)` };
            } catch (e: any) {
              if (isConfigParseError(e)) return CONFIG_NOT_CHECKED;
              return { ok: false, detail: e.message ?? "conflicts check failed" };
            }
          },
        },
        {
          // Ix#270: trust the running container, not the version stamp.
          name: "Backend is the released image",
          run: async () => {
            const status = checkBackendImage(endpoint);
            switch (status.kind) {
              case "ok": {
                if (isNonStandardBackend(status.container)) {
                  return {
                    ok: false, warn: true,
                    detail: `released image, but via a non-standard compose project (${status.container.composeProject ?? "unknown"})`,
                  };
                }
                return { ok: true, detail: "running the released image" };
              }
              case "local-build":
                return {
                  ok: false, warn: true,
                  detail: `running a local build (${status.container.imageRef}), not the released image — ` +
                    `'ix docker stop && ix docker start' pulls ${BACKEND_IMAGE}:latest`,
                };
              case "digest-mismatch":
                return {
                  ok: false, warn: true,
                  detail: "running an older image digest than :latest — " +
                    "'ix docker stop && ix docker start' pulls the released image",
                };
              case "latest-not-pulled":
                return { ok: true, warn: true, detail: `can't verify — ${BACKEND_IMAGE}:latest not pulled locally` };
              case "not-running":
                return { ok: true, detail: `no backend container for ${endpoint} (skipped)` };
              case "remote":
                return { ok: true, detail: "remote endpoint, no local container (skipped)" };
              case "docker-unavailable":
                return { ok: true, detail: "docker unavailable (skipped)" };
            }
          },
        },
        {
          // Ix#271: a graph written by an older engine fails scoped reads silently.
          name: "Graph schema matches engine",
          run: async () => {
            const s = await checkBackendSchema(client, backendCeiling(), isNewer);
            if (!s.reachable) return { ok: true, detail: "backend unreachable (skipped)" };
            if (s.serverVersion === null) return { ok: true, detail: "backend does not report a schema version" };
            if (s.matches) return { ok: true, detail: `schema v${s.serverVersion}` };
            return {
              ok: false, warn: true,
              detail: `graph schema v${s.serverVersion}, this CLI expects v${s.expected} — ` +
                "re-map to rebuild the graph: 'ix map .'",
            };
          },
        },
      ];

      checks.push(
        {
          name: "Config file parses",
          run: async () => assessConfigFile(
            pathJoin(ixHome(), "config.yaml"),
            (p) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
          ),
        },
        { name: "ripgrep on PATH", run: async () => checkRipgrep() },
      );

      // Windows-only: a launcher pointing at a CLI the upgrade moved (Ix#385).
      if (process.platform === "win32") {
        checks.push({
          name: "Windows launcher",
          run: async () =>
            checkWindowsLauncher(
              process.env.IX_HOME || pathJoin(homedir(), ".ix"),
              (p) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
              existsSync,
            ),
        });
      }

      const results: Array<{ name: string } & CheckResult> = [];
      for (const check of checks) {
        let result: CheckResult;
        try {
          result = await check.run();
        } catch (e) {
          // A check that reached for config.yaml and found it unparseable. Any
          // other throw is a bug in the check and still surfaces.
          if (!isConfigParseError(e)) throw e;
          result = CONFIG_NOT_CHECKED;
        }
        results.push({ name: check.name, ...result });
      }

      const hasFailure = results.some((r) => !r.ok && !r.warn);
      const hasWarning = results.some((r) => r.warn);
      if (hasFailure) process.exitCode = 1;

      if (opts.format === "llm") {
        printLlmLines(renderDoctorLlm(results, hasFailure, hasWarning));
        return;
      }

      if (opts.format === "json") {
        printJson({ healthy: !hasFailure, hasWarnings: hasWarning, checks: results });
        return;
      }

      renderSection("Ix Doctor");
      console.log();
      for (const r of results) {
        const icon = r.ok ? chalk.green("✓") : r.warn ? chalk.yellow("!") : chalk.red("✗");
        const detail = chalk.dim(` — ${r.detail}`);
        console.log(`  ${icon} ${r.name}${detail}`);
      }

      console.log();
      if (hasFailure) {
        renderError("Some checks failed.");
      } else if (hasWarning) {
        renderSuccess("All checks passed (with warnings).");
      } else {
        renderSuccess("All checks passed.");
      }
      console.log();
    });
}
