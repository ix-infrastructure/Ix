// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * `ix install`: a menu in front of `scripts/install-skill.sh`, never a second
 * installer (#612).
 *
 * The script stays the only engine. It owns the harness registry (through
 * `ix-cli/scripts/skill-harnesses.mjs`), the presence probes, the refusal guard
 * for a foreign skill that happens to be called `ix`, and the `--json` report.
 * This module only runs it: first with `--dry-run --json` to learn what is on
 * this machine, then once more with the flags the menu collected. Every row the
 * menu prints comes from that preview, so a harness added to the registry shows
 * up here with no edit, and the menu cannot disagree with the script about what
 * it would do.
 *
 * Rules the menu keeps:
 * - Nothing is written until the person confirms. Everything before that is a
 *   `--dry-run` call.
 * - Off a terminal, or with `--yes`, there is no menu. `--dry-run` and `--yes`
 *   pass straight through to the script; without either, a hint is printed
 *   and nothing is written.
 * - Prompts, the banner and the rows go to stderr. With `--json`, stdout is the
 *   script's own report and nothing else, byte for byte.
 * - No colour, no spinner: the output is plain lines, so CI and `TERM=dumb`
 *   read the same thing.
 */

/** One host in the script's `--json` report. */
export interface SkillHost {
  id: string;
  action: string;
  dest: string | null;
  detectedVia: string;
}

/** The script's `--json` report. */
export interface SkillReport {
  dryRun: boolean;
  hosts: SkillHost[];
}

export interface EngineResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `scripts/install-skill.sh` with these arguments. */
export type SkillEngine = (args: string[]) => EngineResult;

export interface InstallOptions {
  ids: string[];
  dryRun: boolean;
  force: boolean;
  json: boolean;
  yes: boolean;
}

export interface InstallMenuDeps {
  engine: SkillEngine;
  /** Whether a person can answer prompts (stdin and stderr are terminals). */
  interactive: boolean;
  /** Ask one question on stderr; resolves null when input closes or is cancelled. */
  ask: (question: string) => Promise<string | null>;
  /** stdout. */
  out: (text: string) => void;
  /** stderr. */
  err: (text: string) => void;
  banner: () => string | null;
}

const SCRIPT_LABEL = "bash scripts/install-skill.sh";

/**
 * Where the engine lives: the repository root, three levels above this file in
 * both `src/cli/` and `dist/cli/`. Only that location is tried. Looking in the
 * working directory would run whatever `scripts/install-skill.sh` the current
 * directory happens to hold.
 *
 * Null when the CLI was installed without the repository around it (the npm
 * package and the release archives carry neither the script nor `skills/ix`).
 */
export function locateSkillInstaller(fromUrl: string = import.meta.url): string | null {
  const root = join(dirname(fileURLToPath(fromUrl)), "..", "..", "..");
  const script = join(root, "scripts", "install-skill.sh");
  return existsSync(script) && existsSync(join(root, "skills", "ix", "SKILL.md")) ? script : null;
}

/** The real engine: `bash <script> <args>`, output captured. */
export function createSkillEngine(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillEngine {
  return (args) => {
    const run = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (run.error) {
      const code = (run.error as NodeJS.ErrnoException).code ?? run.error.message;
      return {
        status: 1,
        stdout: "",
        stderr: `error: could not run bash (${code}); the skill installer is a bash script (on Windows, use Git Bash)\n`,
      };
    }
    return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  };
}

/** The arguments the script would get for these choices, in its own spelling. */
export function engineArgs(
  opts: Pick<InstallOptions, "ids" | "dryRun" | "force" | "json">,
): string[] {
  return [
    ...(opts.dryRun ? ["--dry-run"] : []),
    ...(opts.force ? ["--force"] : []),
    ...(opts.json ? ["--json"] : []),
    ...opts.ids,
  ];
}

/** Parse the script's `--json` stdout; null when it is not that report. */
export function parseSkillReport(stdout: string): SkillReport | null {
  try {
    const parsed = JSON.parse(stdout) as Partial<SkillReport>;
    if (typeof parsed?.dryRun !== "boolean" || !Array.isArray(parsed.hosts)) return null;
    const hosts = parsed.hosts.filter(
      (h): h is SkillHost =>
        typeof h?.id === "string" && h.id !== "" && typeof h.action === "string",
    );
    return { dryRun: parsed.dryRun, hosts };
  } catch {
    return null;
  }
}

function nonInteractiveHint(): string {
  return [
    "ix install: not an interactive terminal, so nothing was written.",
    "  Preview: ix install --dry-run [--json] [harness-ids...]",
    "  Apply:   ix install --yes [--force] [--json] [harness-ids...]",
    `  Both run ${SCRIPT_LABEL} with the same options.`,
  ].join("\n");
}

function describeHost(host: SkillHost): string {
  switch (host.action) {
    case "would-install":
      return `found (${host.detectedVia}), would install to ${host.dest}`;
    case "would-refuse":
      return `found (${host.detectedVia}), ${host.dest} holds a different skill named ix`;
    case "skip":
      return "not found";
    default:
      return host.dest ? `${host.action} ${host.dest}` : host.action;
  }
}

/** One line per host, numbered, in the order the script reported them. */
export function renderRows(hosts: SkillHost[], selected?: ReadonlySet<string>): string[] {
  const width = Math.max(...hosts.map((h) => h.id.length), 2);
  return hosts.map((host, i) => {
    const mark = selected ? (selected.has(host.id) ? "[x] " : "[ ] ") : "";
    return `  ${mark}${String(i + 1).padStart(2)}. ${host.id.padEnd(width)}  ${describeHost(host)}`;
  });
}

/**
 * Turn an answer to the harness question into ids. Accepts ids or row numbers,
 * separated by spaces or commas; an empty answer keeps the default; `none`
 * selects nothing. Returns an error message for anything it cannot place.
 */
export function parseSelection(
  answer: string,
  hosts: SkillHost[],
  fallback: string[],
): { ids: string[] } | { error: string } {
  const tokens = answer.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return { ids: fallback };
  if (tokens.length === 1 && tokens[0].toLowerCase() === "none") return { ids: [] };
  const ids: string[] = [];
  for (const token of tokens) {
    const byNumber = /^\d+$/.test(token) ? hosts[Number(token) - 1] : undefined;
    const host = byNumber ?? hosts.find((h) => h.id === token);
    if (!host)
      return {
        error: `'${token}' is not a row number or harness id (${hosts.map((h) => h.id).join(", ")})`,
      };
    if (!ids.includes(host.id)) ids.push(host.id);
  }
  // Registry order, so the equivalent command reads the same however it was typed.
  return { ids: hosts.map((h) => h.id).filter((id) => ids.includes(id)) };
}

function passThrough(deps: InstallMenuDeps, args: string[]): number {
  const run = deps.engine(args);
  if (run.stdout) deps.out(run.stdout);
  if (run.stderr) deps.err(run.stderr);
  return run.status;
}

/** A `--dry-run --json` run of the engine, parsed; reports its own failure. */
function preview(deps: InstallMenuDeps, ids: string[], force: boolean): SkillReport | null {
  const run = deps.engine(engineArgs({ ids, dryRun: true, force, json: true }));
  // A predicted refusal exits 1 with a full report on stdout, so the exit
  // status alone does not mean the preview failed.
  const report = parseSkillReport(run.stdout);
  if (!report) {
    deps.err(run.stderr || `error: ${SCRIPT_LABEL} --dry-run --json did not print a report\n`);
    return null;
  }
  return report;
}

const CANCELLED = "Cancelled. Nothing was written.";

/**
 * Run `ix install`. Returns the exit code: the script's own when it ran for
 * real, 0 when the person declined, 1 when nothing could be done.
 */
export async function runInstallMenu(opts: InstallOptions, deps: InstallMenuDeps): Promise<number> {
  const { err } = deps;

  if (!deps.interactive || opts.yes) {
    if (!opts.dryRun && !opts.yes) {
      err(nonInteractiveHint());
      return 1;
    }
    return passThrough(deps, engineArgs(opts));
  }

  err(deps.banner() ?? "  Ix");
  err("");

  // No --force here even when it was passed: the first look has to show which
  // destinations hold someone else's skill, so the force question can name them.
  const machine = preview(deps, [], false);
  if (!machine) return 1;
  if (machine.hosts.length === 0) {
    err("error: the harness registry reported no harnesses");
    return 1;
  }

  const known = new Set(machine.hosts.map((h) => h.id));
  const unknown = opts.ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    err(`error: unknown harness id '${unknown[0]}'`);
    err(`       valid ids: ${[...known].join(" ")}`);
    return 1;
  }

  const found = machine.hosts.filter((h) => h.action !== "skip").map((h) => h.id);
  const fallback =
    opts.ids.length > 0
      ? machine.hosts.map((h) => h.id).filter((id) => opts.ids.includes(id))
      : found;

  err("Ix skill: agent harnesses on this machine");
  for (const line of renderRows(machine.hosts, new Set(fallback))) err(line);
  err("");

  // (a) which harnesses
  let ids: string[] | null = null;
  while (ids === null) {
    const answer = await deps.ask(
      `Harnesses to install [${fallback.join(" ") || "none"}] (ids or row numbers, Enter keeps, 'none' for none): `,
    );
    if (answer === null) {
      err(CANCELLED);
      return 1;
    }
    const picked = parseSelection(answer, machine.hosts, fallback);
    if ("error" in picked) err(picked.error);
    else ids = picked.ids;
  }
  if (ids.length === 0) {
    err("Nothing selected. Nothing was written.");
    return 0;
  }

  // (b) dry run or apply
  let dryRun: boolean | null = null;
  const dryDefault = opts.dryRun ? "d" : "a";
  while (dryRun === null) {
    const answer = await deps.ask(`Apply, or dry run only? [a/d] (default ${dryDefault}): `);
    if (answer === null) {
      err(CANCELLED);
      return 1;
    }
    const choice = (answer.trim().toLowerCase() || dryDefault)[0];
    if (choice === "a") dryRun = false;
    else if (choice === "d") dryRun = true;
    else err("Answer a (apply) or d (dry run).");
  }

  // (c) force or refuse, asked only where the preview found a conflict
  let force = opts.force;
  const chosen = new Set(ids);
  const conflicts = machine.hosts.filter((h) => chosen.has(h.id) && h.action === "would-refuse");
  if (conflicts.length > 0) {
    err("");
    err("These destinations already hold a skill named ix that is not the Ix skill:");
    for (const host of conflicts) err(`  ${host.id}: ${host.dest}`);
    const forceDefault = opts.force ? "y" : "n";
    let decided: boolean | null = null;
    while (decided === null) {
      const answer = await deps.ask(
        `Overwrite them (--force)? [y/n] (default ${forceDefault}; n leaves them and refuses those hosts): `,
      );
      if (answer === null) {
        err(CANCELLED);
        return 1;
      }
      const choice = (answer.trim().toLowerCase() || forceDefault)[0];
      if (choice === "y") decided = true;
      else if (choice === "n") decided = false;
      else err("Answer y or n.");
    }
    force = decided;
  }

  const chosenArgs = engineArgs({ ids, dryRun, force, json: opts.json });
  err("");
  err(`Equivalent command: ${SCRIPT_LABEL} ${chosenArgs.join(" ")}`);

  if (dryRun) return passThrough(deps, chosenArgs);

  // The plan the confirmation is about: the engine's own preview of exactly
  // the run that would follow.
  const plan = preview(deps, ids, force);
  if (!plan) return 1;
  err("");
  err("Plan:");
  for (const line of renderRows(plan.hosts)) err(line);
  const writes = plan.hosts.filter((h) => h.action === "would-install").length;
  if (writes === 0) {
    err("");
    err("Nothing would be installed. Nothing was written.");
    return plan.hosts.some((h) => h.action === "would-refuse") ? 1 : 0;
  }

  err("");
  const confirm = await deps.ask(`Write the Ix skill to ${writes} harness(es) now? [y/N]: `);
  if (confirm === null) {
    err(CANCELLED);
    return 1;
  }
  if (confirm.trim().toLowerCase()[0] !== "y") {
    err("Nothing was written.");
    return 0;
  }
  return passThrough(deps, chosenArgs);
}

/**
 * A question/answer loop on the real terminal: prompts on stderr, answers from
 * stdin. Ctrl-C or end of input resolves null, which the menu treats as cancel.
 */
export function terminalAsk(): { ask: InstallMenuDeps["ask"]; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let closed = false;
  const waiting = new Set<(answer: string | null) => void>();
  rl.on("SIGINT", () => rl.close());
  rl.on("close", () => {
    closed = true;
    for (const resolve of waiting) resolve(null);
    waiting.clear();
  });
  const ask = (question: string): Promise<string | null> =>
    closed
      ? Promise.resolve(null)
      : new Promise((resolve) => {
          waiting.add(resolve);
          rl.question(question, (answer) => {
            waiting.delete(resolve);
            resolve(answer);
          });
        });
  return { ask, close: () => rl.close() };
}
