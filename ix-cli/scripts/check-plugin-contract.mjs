#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

/**
 * Plugin contract check: every `ix …` invocation in the editor plugins must
 * name a command this CLI registers, with long flags that command accepts.
 *
 * The plugins call the CLI from code (argv arrays handed to runIx / safeRun /
 * run_ix_json) and tell agents to call it from prompt and skill text. Both
 * break silently when a flag is renamed or removed here: nothing in this repo
 * ever looked at them.
 *
 *   node scripts/check-plugin-contract.mjs <plugins-dir>   # one checkout per plugin under it
 *   node scripts/check-plugin-contract.mjs --clone          # shallow-clone the six plugins' main first
 *
 * Needs a build (`npm run build`): the surface comes from scripts/dump-cli-surface.mjs.
 * Exit 1 when an invocation names an unknown command or flag. Known false
 * positives go in scripts/plugin-contract-ignore.json.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS = [
  "ix-claude-plugin", "ix-codex-plugin", "ix-cursor-plugin",
  "ix-gemini-plugin", "ix-openclaw-plugin", "ix-opencode-plugin",
];
/** Ix Pro commands: registered by @ix/pro, not by this build. */
const PRO_COMMANDS = new Set([
  "plan", "plans", "task", "tasks", "workflow", "workflows", "decide", "decisions",
  "goal", "goals", "truth", "bug", "bugs", "briefing",
]);
/** Accepted by every command (commander adds --help; --version is the root's). */
const GLOBAL_FLAGS = new Set(["--help", "--version"]);
const CODE_EXT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py"]);
const TEXT_EXT = new Set([".md", ".json", ".toml", ".yaml", ".yml", ".txt", ".mdc"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "__pycache__", ".venv"]);
/** History, not instructions: changelogs and dated plans and test logs quote old invocations on purpose. */
const HISTORICAL = /(^|\/)(CHANGELOG[^/]*|[^/]*_PLAN\.md|[^/]*_LOG\.md)$/i;

function loadSurface() {
  const out = execFileSync(process.execPath, [join(here, "dump-cli-surface.mjs")], { encoding: "utf8" });
  const commands = new Map();
  for (const entry of JSON.parse(out)) {
    // "ix callers", "ix docker start": keyed without the leading "ix".
    commands.set(entry.command.replace(/^ix ?/, ""), {
      flags: new Set(entry.options.map((o) => o.long).filter(Boolean)),
      subcommands: new Set(entry.subcommands ?? []),
    });
  }
  return commands;
}

function loadIgnores() {
  try {
    return JSON.parse(readFileSync(join(here, "plugin-contract-ignore.json"), "utf8")).ignore ?? [];
  } catch {
    return [];
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* walk(path);
    else if (st.size < 1_000_000) yield path;
  }
}

const STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g;

/** Invocations in code: argv arrays handed to something that runs ix. */
function codeInvocations(text) {
  const found = [];
  const call = /([A-Za-z_][\w.]*)\(\s*\[([^\]]*)\]/g;
  for (const m of text.matchAll(call)) {
    const fn = m[1];
    const items = [...m[2].matchAll(STRING)].map((s) => s[1] ?? s[2] ?? s[3]);
    const startsWithIx = items[0] === "ix";
    if (!startsWithIx && !/ix|safeRun|run_?ix/i.test(fn)) continue;
    const argv = startsWithIx ? items.slice(1) : items;
    if (argv.length === 0) continue;
    // `[...args, "--format", "llm"]` and `["--version"]` carry no command of their own.
    if (/^\s*\.\.\./.test(m[2]) || argv[0].startsWith("-")) continue;
    found.push({ argv, line: lineOf(text, m.index), snippet: m[0].slice(0, 100) });
  }
  return found;
}

/** Invocations in text: `ix …` code spans, and lines of fenced blocks starting with `ix `. */
function textInvocations(text) {
  const found = [];
  for (const m of text.matchAll(/`(ix\s+[a-z][^`\n]*)`/g)) {
    found.push({ argv: tokens(m[1]), line: lineOf(text, m.index), snippet: m[1].slice(0, 100) });
  }
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
    const line = raw.trim();
    if (inFence && /^ix\s+[a-z]/.test(line)) found.push({ argv: tokens(line), line: i + 1, snippet: line.slice(0, 100) });
  });
  return found;
}

/**
 * Invocations in a JSON file's string values. Agent definitions keep their
 * prompts as JSON strings, where a fenced block's newlines are `\n` escapes:
 * scanned as raw text, those blocks are invisible.
 */
function jsonInvocations(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return textInvocations(text);
  }
  const found = [];
  const visit = (value, path) => {
    if (typeof value === "string") {
      for (const inv of textInvocations(value)) found.push({ ...inv, line: `${path}:${inv.line}` });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(data, "");
  return found;
}

/** Split `ix cmd arg --flag x | other` into argv, stopping at shell operators. */
function tokens(command) {
  const out = [];
  for (const t of command.replace(/^ix\s+/, "").split(/\s+/)) {
    if (["|", "&&", "||", ";", ">", "2>&1"].includes(t) || t.startsWith("#")) break;
    out.push(t);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** What is wrong with one invocation, or null. */
function check(argv, surface) {
  const cmd = argv[0];
  if (!/^[a-z][a-z-]*$/.test(cmd)) return null; // a placeholder or a variable
  if (PRO_COMMANDS.has(cmd)) return null;
  const top = surface.get(cmd);
  if (!top) return `unknown command "${cmd}"`;
  let entry = top;
  let name = cmd;
  const sub = argv[1];
  if (sub && top.subcommands.has(sub) && surface.has(`${cmd} ${sub}`)) {
    entry = surface.get(`${cmd} ${sub}`);
    name = `${cmd} ${sub}`;
  }
  const bad = argv
    .filter((a) => /^--[a-z][a-z0-9-]*/.test(a))
    .map((a) => a.split("=")[0])
    .filter((f) => !entry.flags.has(f) && !GLOBAL_FLAGS.has(f));
  return bad.length ? `"${name}" has no ${bad.join(", ")}` : null;
}

function main(argv) {
  let dir = argv.find((a) => !a.startsWith("--"));
  if (argv.includes("--clone")) {
    dir = mkdtempSync(join(tmpdir(), "ix-plugins-"));
    for (const repo of PLUGINS) {
      execFileSync("git", ["clone", "-q", "--depth", "1", `https://github.com/ix-infrastructure/${repo}`, join(dir, repo)], { stdio: "inherit" });
    }
  }
  if (!dir) {
    console.error("usage: node scripts/check-plugin-contract.mjs <plugins-dir> | --clone");
    return 2;
  }
  const surface = loadSurface();
  const ignores = loadIgnores();
  const problems = [];
  let checked = 0;
  for (const repo of PLUGINS) {
    const root = join(dir, repo);
    try { statSync(root); } catch { console.error(`missing ${root}`); return 2; }
    for (const file of walk(root)) {
      const ext = extname(file);
      if (!CODE_EXT.has(ext) && !TEXT_EXT.has(ext)) continue;
      if (HISTORICAL.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("ix")) continue;
      const invocations = [
        ...(CODE_EXT.has(ext) ? codeInvocations(text) : []),
        ...(ext === ".json" ? jsonInvocations(text) : textInvocations(text)),
      ];
      for (const inv of invocations) {
        checked++;
        const problem = check(inv.argv, surface);
        if (!problem) continue;
        const where = `${repo}/${relative(root, file)}:${inv.line}`;
        if (ignores.some((ig) => where.startsWith(ig.where) && (!ig.match || inv.snippet.includes(ig.match)))) continue;
        problems.push(`${where}  ${problem}\n    ${inv.snippet}`);
      }
    }
  }
  console.log(`checked ${checked} ix invocations in ${PLUGINS.length} plugins`);
  if (problems.length) {
    console.error(`\n${problems.length} invocation(s) use a command or flag this CLI does not have:\n\n${problems.join("\n")}`);
    console.error(`\nA false positive (prompt prose, a placeholder) goes in scripts/plugin-contract-ignore.json.`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
