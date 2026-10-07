// Copyright 2026 Ix Infrastructure Inc.

// Helpers for the real-backend scenarios in this directory. A scenario works on
// a copy of a fixture in a temp dir (git-initialised, with its own IX_HOME),
// drives the built CLI against the e2e backend, and compares graph signatures
// read straight from that backend's ArangoDB.

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
// @ts-expect-error -- plain .mjs module, also run on its own from the command line
import { diffSignatures, formatDiff, graphSignature, summary } from "./graph-sig.mjs";

export interface Signature {
  nodes: string[];
  edges: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");
const CLI = resolve(HERE, "../../dist/cli/main.js");

// Ports of stacks that hold someone's real graph. Every scenario resets the
// whole database, so the harness refuses to run against any of them:
// 8090/8529 the default install (and ix-bench), 8091/8530 helm-eval,
// 8100/8540 a personal backend, 8099/8539 the benchmark RAM stack,
// 8190/8629 the audit stack.
const PROTECTED_PORTS = new Set([8090, 8091, 8099, 8100, 8190, 8529, 8530, 8539, 8540, 8629]);

export interface E2eEnv {
  endpoint: string;
  arangoUrl: string;
  token?: string;
}

function checkUrl(name: string, raw: string): URL {
  const url = new URL(raw);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name}=${raw}: the e2e harness only runs against a loopback backend`);
  }
  if (PROTECTED_PORTS.has(port)) {
    throw new Error(
      `${name}=${raw}: port ${port} belongs to a shared stack and every scenario resets the database. ` +
        "Use the e2e stack's own ports (see test/e2e/README.md).",
    );
  }
  return url;
}

/** Reads and checks the environment. Throws instead of touching a shared stack. */
export function e2eEnv(): E2eEnv {
  if (process.env.IX_E2E !== "1") {
    throw new Error(
      "Set IX_E2E=1 to run the real-backend harness: every scenario resets the backend's database.",
    );
  }
  const backendPort = process.env.IX_E2E_BACKEND_PORT ?? "8290";
  const arangoPort = process.env.IX_E2E_ARANGO_PORT ?? "8729";
  const endpoint = process.env.IX_E2E_ENDPOINT ?? `http://127.0.0.1:${backendPort}`;
  const arangoUrl = process.env.IX_E2E_ARANGO_URL ?? `http://127.0.0.1:${arangoPort}`;
  checkUrl("backend endpoint", endpoint);
  checkUrl("ArangoDB URL", arangoUrl);
  if (!existsSync(CLI)) throw new Error(`${CLI} not found: run npm run build first`);
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    arangoUrl,
    token: process.env.IX_TOKEN || undefined,
  };
}

function headers(env: E2eEnv): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (env.token) h.authorization = `Bearer ${env.token}`;
  return h;
}

/** POST /v1/reset: empties the whole e2e database. */
export async function resetBackend(env: E2eEnv): Promise<void> {
  const res = await fetch(`${env.endpoint}/v1/reset`, {
    method: "POST",
    headers: headers(env),
    body: "{}",
  });
  if (!res.ok) throw new Error(`POST /v1/reset: ${res.status} ${await res.text()}`);
}

/** A working copy: a git repo in a temp dir plus the IX_HOME the CLI uses for it. */
export interface Checkout {
  dir: string;
  ixHome: string;
}

const scratchRoots: string[] = [];

/** Removes every temp dir made by this process's checkouts. */
export function cleanupScratch(): void {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=ix-e2e",
      "-c",
      "user.email=e2e@ix.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * Copies `fixture` (a directory under fixtures/, or an absolute path) to
 * `<tmp>/<name>` and commits it on branch main. The directory name defaults to
 * the fixture's, so a fresh reference copy and the edited copy share a basename.
 */
export function checkout(fixture: string, name = basename(fixture)): Checkout {
  const root = mkdtempSync(join(tmpdir(), "ix-e2e-"));
  scratchRoots.push(root);
  const dir = join(root, name);
  const src = fixture.startsWith("/") ? fixture : join(FIXTURES, fixture);
  cpSync(src, dir, { recursive: true, filter: (p) => basename(p) !== ".git" });
  const ixHome = join(root, "ix-home");
  mkdirSync(ixHome);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return { dir: realpathSync(dir), ixHome };
}

export interface IxResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI in `co.dir`. Throws on a non-zero exit unless `allowFail`. */
export function ix(env: E2eEnv, co: Checkout, args: string[], allowFail = false): IxResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: co.dir,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      IX_HOME: co.ixHome,
      IX_ENDPOINT: env.endpoint,
      IX_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    },
  });
  const out = { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (!allowFail && out.status !== 0) {
    throw new Error(
      `ix ${args.join(" ")} exited ${out.status}${res.error ? ` (${res.error.message})` : ""}\n${out.stderr}${out.stdout}`,
    );
  }
  return out;
}

/** `ix map <dir> --silent`: ingest (incrementally after the first run) and persist the map. */
export function map(env: E2eEnv, co: Checkout): IxResult {
  return ix(env, co, ["map", co.dir, "--silent"]);
}

/** The workspace id the CLI registered for `co.dir` in its IX_HOME. */
export function workspaceId(co: Checkout): string {
  const config = parseYaml(readFileSync(join(co.ixHome, "config.yaml"), "utf8")) as {
    workspaces?: Array<{ workspace_id: unknown; root_path: string }>;
  };
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const ws = (config.workspaces ?? []).find((w) => real(w.root_path) === co.dir);
  if (!ws) throw new Error(`no workspace for ${co.dir} in ${co.ixHome}/config.yaml`);
  return String(ws.workspace_id);
}

/** Signature of the live graph of `co`'s workspace. Refuses an empty graph. */
export async function signature(env: E2eEnv, co: Checkout): Promise<Signature> {
  const sig = (await graphSignature(env.arangoUrl, workspaceId(co))) as Signature;
  if (sig.nodes.length === 0) {
    throw new Error(
      `workspace of ${co.dir} has no live nodes in ${env.arangoUrl}: ` +
        "is IX_E2E_ARANGO_PORT the database behind IX_E2E_BACKEND_PORT?",
    );
  }
  return sig;
}

/**
 * The reference graph for `co`'s current tree: reset the backend and map the
 * same directory once from a new, empty IX_HOME (which holds the CLI's mtime
 * cache and map baseline), so nothing incremental is left. The directory stays
 * the same because the workspace id, and with it the ids of unresolved call
 * targets, derive from the path. Resets again afterwards, so the caller's
 * backend is empty.
 */
export async function freshSignature(env: E2eEnv, co: Checkout): Promise<Signature> {
  await resetBackend(env);
  const root = mkdtempSync(join(tmpdir(), "ix-e2e-home-"));
  scratchRoots.push(root);
  const ref: Checkout = { dir: co.dir, ixHome: root };
  map(env, ref);
  const sig = await signature(env, ref);
  await resetBackend(env);
  return sig;
}

/**
 * Throws, with the difference in the message, unless the two graphs match
 * exactly. With IX_E2E_DIFF_DIR set, every difference is also written to
 * `<dir>/<label>.txt`: an `it.fails` scenario swallows its error, and that
 * file is the only way to see what still differs.
 */
export class GraphMismatch extends Error {}

export function expectSameGraph(label: string, actual: Signature, expected: Signature): void {
  const d = diffSignatures(actual, expected) as { equal: boolean };
  if (d.equal) return;
  const text = `[${label}] graph differs (A = after the edits, B = expected)\n${formatDiff(actual, expected, 6)}`;
  const dir = process.env.IX_E2E_DIFF_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${label.replace(/[^\w.-]+/g, "_")}.txt`),
      formatDiff(actual, expected, 1000) + "\n",
    );
  }
  throw new GraphMismatch(text);
}

/**
 * Wraps a scenario that is known to fail until `tasks` land. Unlike
 * `it.fails`, only a graph mismatch counts as the expected failure: a crashed
 * `ix map` or an unreachable database still fails the run. Once the graphs
 * match, the scenario fails and asks for the marker to be removed.
 */
export function failsUntil(tasks: string[], scenario: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await scenario();
    } catch (err) {
      if (err instanceof GraphMismatch) return;
      throw err;
    }
    throw new Error(
      `This scenario now passes. If ${tasks.join(" / ")} landed, turn it back into a plain it(...) ` +
        "(or drop the landed ids from its title) in the same PR.",
    );
  };
}

export { summary };
