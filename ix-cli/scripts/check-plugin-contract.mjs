#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

/**
 * Plugin contract check: what the six editor plugins rely on in this CLI.
 *
 * The plugins call the CLI from code (argv arrays handed to runIx / safeRun /
 * run_ix_json), read fields out of its `--format json` output, and tell agents
 * to call it and its MCP tools from prompt and skill text. All of it breaks
 * silently when something is renamed or removed here.
 *
 *   node scripts/check-plugin-contract.mjs <plugins-dir>   # one checkout per plugin under it
 *   node scripts/check-plugin-contract.mjs --clone          # shallow-clone the six plugins' main first
 *
 * Needs a build (`npm run build`): everything it checks against is read from
 * dist/, so this script keeps no list of its own. Exit 1 on any problem, 2
 * when it cannot run.
 *
 * What it checks
 *
 * 1. Invocations (.ts .js .py and the text files): every `ix …` names a
 *    registered command (scripts/dump-cli-surface.mjs) or a Pro one
 *    (src/cli/register/pro-surface.ts), with long flags that command accepts.
 *    In code, argv arrays passed to a function whose name says ix; in text,
 *    `ix …` code spans and `ix …` lines of fenced blocks.
 *
 * 2. Output fields (.sh .bash .ts .js .py): a field a plugin reads from a
 *    command's json must be in that command's list in
 *    src/cli/contracts/fields.ts. Only reads the file ties to an invocation
 *    are checked:
 *      - shell: a jq filter on a pipe from `ix <cmd>` or on a variable
 *        assigned from `$(ix <cmd> …)` (also `$(run_ix_json <cmd> …)`,
 *        `"$IX_BIN" <cmd>`, `ix_<cmd>_json`). Only the stages of a filter
 *        that start at the root are read; `map(.x)` and the like are not.
 *      - code: `v.a.b`, `v?.a`, `v["a"][0]`, Python `v.get("a")`, and
 *        `const { a } = …`, on a variable assigned from JSON.parse /
 *        json.loads / a call named *json* or *parse* over an ix argv array,
 *        or over a variable assigned from one.
 *    A read through a function parameter, another file, or `--format llm`
 *    is not seen, and a command with no list in fields.ts is not checked.
 *
 * 3. MCP names (the text files): a code span naming an `ix_…` tool must name
 *    one `ix mcp` serves (src/mcp/server.ts, both tiers). An `ix_…` name the
 *    plugin defines itself is the plugin's, not `ix mcp`'s, and is not
 *    checked, nor is a field read after it: a shell, Python or JS function
 *    (`ix_lib() {`, `def ix_lib`), a file or directory (`ix_lib.sh`), an MCP
 *    tool the plugin serves from its own code (`name: "ix_query"`,
 *    `server.tool("ix_query"`, a `{ ix_query: { … } }` table), and any
 *    `ix_<cmd>_json` wrapper. A code span
 *    that is a JSON path (`a.b`, `a[0]`, `.a`) after a tool in the same
 *    Markdown section (up to a heading or an `ix …` command span) fails when
 *    that tool returns `--format llm` records, which have no fields to read:
 *    everything not in IX_MCP_JSON_RESULT_TOOLS. Not checked, because they
 *    read the same as a symbol name or a URL in an example: a plain name
 *    (`ok`, `risk_level`); a dotted name given as an argument, either right
 *    after the tool with `on`, `for` or `with` between (`ix_callers` on
 *    `auth.verify_token`) or anywhere after `named`, `like`, `e.g.`, `symbol`
 *    and the like (`a symbol like `client.query``), and the names listed
 *    after it with `,`, `or`, `and`; and a host name (`docs.example.com`).
 *
 * Changelogs and dated plans or logs are skipped: they quote old forms on
 * purpose.
 *
 * Ignoring a false positive
 *
 * Add an entry to scripts/plugin-contract-ignore.json:
 *
 *   { "where": "<plugin>/<path>", "match": "<text>", "why": "<reason>" }
 *
 * `where` is matched as a prefix of the reported `<plugin>/<path>:<line>`, so
 * leave the line number off to survive edits. `match` must appear in the
 * reported snippet (the line printed under the problem); leave it out to
 * ignore every problem in the file. Say in `why` what the text really is
 * (prose, a placeholder, a test of a rejected form). A real mismatch is fixed
 * in the plugin or here, not ignored.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));
const PLUGINS = [
  "ix-claude-plugin", "ix-codex-plugin", "ix-cursor-plugin",
  "ix-gemini-plugin", "ix-openclaw-plugin", "ix-opencode-plugin",
];
/** No Pro surface: every Pro command reads as unknown. main() loads the real one. */
const NO_PRO = { commands: new Set(), retired: new Map() };
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

/**
 * Ix Pro commands (registered by @ix/pro, not by this build) and retired Pro
 * names, from the one table in src/cli/register/pro-surface.ts — read from the
 * build, like the rest of the surface, so this script never keeps its own list.
 */
export async function loadProSurface(path = join(here, "..", "dist", "cli", "register", "pro-surface.js")) {
  const { PRO_COMMAND_NAMES, PRO_RETIRED } = await import(pathToFileURL(path).href);
  return { commands: new Set(PRO_COMMAND_NAMES), retired: new Map(Object.entries(PRO_RETIRED)) };
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
    found.push({ argv, line: lineOf(text, m.index), snippet: m[0].slice(0, 100), index: m.index, fn });
  }
  return found;
}

/** Invocations in text: `ix …` code spans, and lines of fenced blocks starting with `ix `. */
export function textInvocations(text) {
  // Template-string prompts escape Markdown backticks in the source. Decode
  // those delimiters before tokenizing so the closing escape is not a flag.
  text = text.replace(/\\`/g, "`");
  const found = [];
  for (const m of text.matchAll(/`(ix\s+[a-z][^`\n]*)`/g)) {
    // Inside a JS template literal the span is written \`ix …\`: the closing
    // backtick's escape is captured as the span's last character.
    const span = m[1].replace(/\\+$/, "");
    found.push({ argv: tokens(span), line: lineOf(text, m.index), snippet: span.slice(0, 100) });
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
export function jsonInvocations(text) {
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

/** A flag's name without `=value` or the escape, quote or punctuation after it. */
function flagName(token) {
  return token.split("=")[0].replace(/[\\`'",.;:!?)\]}]+$/, "");
}

/** What is wrong with one invocation, or null. `pro` comes from {@link loadProSurface}. */
export function check(argv, surface, pro = NO_PRO) {
  const cmd = argv[0];
  if (!/^[a-z][a-z-]*$/.test(cmd)) return null; // a placeholder or a variable
  if (pro.commands.has(cmd)) return null;
  const replacement = pro.retired.get(cmd);
  if (replacement) return `retired Pro command "${cmd}": use "ix ${replacement}"`;
  const top = surface.get(cmd);
  if (!top) return `unknown command "${cmd}"`;
  let entry = top;
  let name = cmd;
  const sub = argv[1];
  if (sub && top.subcommands.has(sub) && surface.has(`${cmd} ${sub}`)) {
    entry = surface.get(`${cmd} ${sub}`);
    name = `${cmd} ${sub}`;
  }
  // Only trailing punctuation is dropped, never a letter or `_`, so `--remapp`
  // and `--re_map` are reported under the name the plugin wrote.
  const bad = argv
    .filter((a) => /^--[a-z][a-z0-9-]*/.test(a))
    .map(flagName)
    .filter((f) => !entry.flags.has(f) && !GLOBAL_FLAGS.has(f));
  return bad.length ? `"${name}" has no ${bad.join(", ")}` : null;
}

// ── Output fields: what the plugins read from `--format json` (#994) ────────

const SHELL_EXT = new Set([".sh", ".bash"]);

/**
 * The published field lists and the MCP catalog, from the build: `acceptsField`
 * from src/cli/contracts/fields.ts, the tool names and the tools that can
 * return JSON from src/mcp/server.ts.
 */
export async function loadFieldSurface(
  fieldsPath = join(here, "..", "dist", "cli", "contracts", "fields.js"),
  serverPath = join(here, "..", "dist", "mcp", "server.js"),
) {
  const { acceptsField } = await import(pathToFileURL(fieldsPath).href);
  const { IX_MCP_TOOL_NAMES, IX_MCP_JSON_RESULT_TOOLS } = await import(pathToFileURL(serverPath).href);
  return {
    accepts: acceptsField,
    mcp: { tools: new Set(IX_MCP_TOOL_NAMES), jsonResults: new Set(IX_MCP_JSON_RESULT_TOOLS) },
  };
}

/** What is wrong with one field read, or null. Commands with no published list are not checked. */
export function checkField(command, path, fields) {
  return fields.accepts(command, path) === false ? `"ix ${command} --format json" has no field "${path}"` : null;
}

/**
 * Field reads in plugin code, each tied to the ix command whose json output it
 * reads: `[{ command, path, line, snippet }]`. Only reads the file itself ties
 * to an invocation are returned; see the header for the forms recognized.
 */
export function fieldReads(text, file, commands) {
  const ext = extname(file);
  if (SHELL_EXT.has(ext)) return shellReads(text, commands);
  if (ext === ".py") return codeReads(text, commands, true);
  if (CODE_EXT.has(ext)) return codeReads(text, commands, false);
  return [];
}

/** `--format llm` or `--format text` in an argv or command line: not json. */
const NOT_JSON = /--format(?:=|\s+|",\s*")["']?(?:llm|text)\b/;

/** A shell word that runs ix: `ix`, a path ending in it, `run_ix_json`, `"$IX_BIN"`. */
function runsIx(word) {
  const bare = word.replace(/^["']|["']$/g, "");
  if (/^\$\{?(?:IX|[A-Z_]*_IX|IX_[A-Z_]+)\}?$/.test(bare)) return true;
  return /(?:^|[/_-])ix(?:$|[_-])/i.test(bare);
}

/** Ix invocations on one shell line: `[{ command, json, index }]`. */
function shellInvocations(line, commands) {
  const found = [];
  const word = /(?<=^|[\s;&|({"'`=])("?\$\{?[A-Za-z_]\w*\}?"?|[\w./-]+)\s+["']?([a-z][a-z-]*)["']?(?=[\s"')|;&]|$)/g;
  for (const m of line.matchAll(word)) {
    if (runsIx(m[1]) && commands.has(m[2])) found.push({ command: m[2], json: !NOT_JSON.test(line), index: m.index });
  }
  // A wrapper that names its command: `ix_locate_json "$sym"`.
  for (const m of line.matchAll(/(?<=^|[\s;&|({"'`=])(?:[\w-]*[_-])?ix[_-]([a-z]+)(?=[_-]|\s|$)/g)) {
    if (commands.has(m[1]) && !found.some((f) => f.index <= m.index + m[0].length && f.index >= m.index)) {
      found.push({ command: m[1], json: !NOT_JSON.test(line), index: m.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Shell words, quotes kept: `'a b'`, `"$x"`, `--flag`. */
function shellWords(text) {
  return [...text.matchAll(/'[^']*'|"(?:[^"\\]|\\.)*"|[^\s|;&)]+/g)].map((m) => m[0]);
}

/** The filter of a `jq …` command, or null (`-f file`, or none found). */
function jqFilter(rest) {
  const words = shellWords(rest);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^--(?:arg|argjson|slurpfile|rawfile)$/.test(w)) { i += 2; continue; }
    if (/^--indent$/.test(w)) { i += 1; continue; }
    if (w === "-f" || w === "--from-file") return null;
    if (w.startsWith("-")) continue;
    return { filter: w.replace(/^'([\s\S]*)'$|^"([\s\S]*)"$/, (_, a, b) => a ?? b), after: words.slice(i + 1).join(" ") };
  }
  return null;
}

/** Reads in a shell file: jq filters on a variable or pipe that holds ix json. */
function shellReads(text, commands) {
  const lines = text.split("\n");
  /** name -> [{ line, source }], source `{command, json}` or null for a non-ix value. */
  const vars = new Map();
  const reads = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[\s;&(])(?:(?:local|export|readonly|declare(?:\s+-\w+)?)\s+)?([A-Za-z_]\w*)=(\S.*)$/g)) {
      const invs = /\$\(|`/.test(m[2]) ? shellInvocations(m[2], commands) : [];
      if (!vars.has(m[1])) vars.set(m[1], []);
      vars.get(m[1]).push({ line: i, col: m.index, source: invs[0] ?? null });
    }
    for (const m of line.matchAll(/jq\b/g)) {
      if (m.index > 0 && /[\w-]/.test(line[m.index - 1])) continue;
      const jq = jqFilter(line.slice(m.index + 2));
      if (!jq) continue;
      const before = line.slice(0, m.index);
      let source;
      const pipe = /\|\s*$/.exec(before);
      if (pipe) {
        const left = before.slice(0, pipe.index);
        const invs = shellInvocations(left, commands);
        if (invs.length) source = invs.at(-1);
        else source = lookup(vars, [...left.matchAll(/\$\{?([A-Za-z_]\w*)/g)].at(-1)?.[1], i, m.index);
      } else {
        source = lookup(vars, /<<<\s*"?\$\{?([A-Za-z_]\w*)/.exec(jq.after)?.[1], i, m.index);
      }
      if (!source?.json) continue;
      for (const path of jqPaths(jq.filter)) {
        reads.push({ command: source.command, path, line: i + 1, snippet: line.trim().slice(0, 100) });
      }
    }
  });
  return reads;
}

/** The value a variable held at (`line`, `col`): its last assignment before that point. */
function lookup(vars, name, line, col) {
  if (!name) return undefined;
  return (vars.get(name) ?? []).filter((a) => a.line < line || (a.line === line && a.col < col)).at(-1)?.source;
}

/** Split at a top-level separator, outside strings and brackets. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0, start = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0 && text[i + 1] !== "=") { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `.a.b`, `.[0]`, `."k"`, `.["k"]`, `[]?`: one jq path, from its leading dot. */
const JQ_PATH = /^\.(?:[A-Za-z_]\w*|"[^"]*"|\[[^\]]*\])?(?:\??(?:\.[A-Za-z_]\w*|\."[^"]*"|\.?\[[^\]]*\]))*\??/;

/** A jq path in the syntax of contracts/fields.ts: `a.b`, `a[]`. */
function normalizeJq(raw) {
  return raw
    .replace(/\?/g, "")
    .replace(/\.?\[\s*"([^"]*)"\s*\]/g, ".$1")
    .replace(/\."([^"]*)"/g, ".$1")
    .replace(/\.?\[[^\]]*\]/g, "[]")
    .replace(/^\./, "");
}

function joinPath(ctx, path) {
  if (!ctx) return path;
  if (!path) return ctx;
  return path.startsWith("[") ? ctx + path : `${ctx}.${path}`;
}

/**
 * The root-relative field paths a jq filter reads. A pipe stage that is a
 * plain path sets the context for the next one; after any other stage the
 * context is unknown and reading stops. Paths inside a function call
 * (`map(.x)`, `select(.x)`) are relative to something else and are skipped.
 */
function jqPaths(filter) {
  const out = [];
  let ctx = "";
  for (const raw of splitTop(filter, "|")) {
    const stage = raw.trim();
    for (const path of stagePaths(stage)) {
      const full = joinPath(ctx, path);
      if (full) out.push(full);
    }
    const whole = JQ_PATH.exec(stage);
    if (!whole || whole[0] !== stage) break;
    ctx = joinPath(ctx, normalizeJq(stage));
  }
  return out;
}

/** Paths in one pipe stage that start at its input, outside function calls. */
function stagePaths(stage) {
  const found = [];
  const frames = [];
  let quote = false;
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i];
    if (quote) { if (c === "\\") i++; else if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if ("([{".includes(c)) {
      frames.push(c === "(" && /[A-Za-z_0-9]\s*$/.test(stage.slice(0, i)) ? "call" : c);
      continue;
    }
    if (")]}".includes(c)) { frames.pop(); continue; }
    if (c !== ".") continue;
    const prev = stage.slice(0, i).trimEnd().at(-1);
    if (prev && /[\w$)\]."?]/.test(prev)) continue;
    if (stage[i + 1] === ".") { i++; continue; }
    const m = JQ_PATH.exec(stage.slice(i));
    if (!m) continue;
    if (!frames.includes("call")) {
      const path = normalizeJq(m[0]);
      if (path) found.push(path);
    }
    i += m[0].length - 1;
  }
  return found;
}

/** Parameter lists: `def f(a, b)`. */
const PY_PARAMS = /\bdef\s+(\w+)\s*\(([^)]*)\)/g;
/**
 * Parameter lists: `function f(a)` (groups 1, 2), `m(a) {` (3, 4), `(a) =>`
 * (5), `a =>` (6). An `if (…) {` matches the method form and is skipped.
 */
const JS_PARAMS = /(?:\bfunction\b\s*\*?\s*([\w$]*)\s*\(([^)]*)\)|\b([\w$]+)\s*\(([^()]*)\)\s*(?::\s*[^={;]+)?\{|\(([^()]*)\)\s*(?::\s*[^=;{]+)?=>|\b([A-Za-z_$][\w$]*)\s*=>)/g;

/** Method names that end a property chain: what follows is not a field. */
const CHAIN_END = new Set(["length"]);

/**
 * Reads in TypeScript, JavaScript or Python: property chains, subscripts and
 * `.get("k")` on a variable holding parsed ix json, and destructuring of it.
 * A variable holds parsed json when it is assigned from a call whose name
 * says json or parse (`JSON.parse`, `json.loads`, `runIxJson`, `run_ix_json`)
 * over an ix invocation or over a variable assigned from one.
 */
function codeReads(text, commands, python) {
  const invocations = codeInvocations(text).filter((inv) => commands.has(inv.argv[0]));
  /** name -> [{ index, value }], value `{command, json, parsed}` or null. */
  const vars = new Map();
  const lineEnd = (i) => { const e = text.indexOf("\n", i); return e < 0 ? text.length : e; };
  const assign = python
    ? /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)\s*/gm
    : /(?:\b(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*(?::[^=\n;]+)?=(?![=>])\s*/gm;
  const reads = [];
  const valueOf = (rhsStart) => {
    const end = lineEnd(rhsStart);
    const rhs = text.slice(rhsStart, end);
    const parse = /(?:JSON\.parse|json\.loads?|[\w.]*(?:parse|json)\w*)\s*\(/i;
    const inv = invocations.find((v) => v.index >= rhsStart && v.index < end);
    if (inv) {
      const json = !NOT_JSON.test(text.slice(inv.index, inv.index + inv.snippet.length)) && !NOT_JSON.test(inv.argv.join(" "));
      return { command: inv.argv[0], json, parsed: parse.test(rhs.slice(0, inv.index - rhsStart)) || /json/i.test(inv.fn) };
    }
    const named = [...rhs.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => ({ name: m[0], at: rhsStart + m.index }));
    for (const { name, at } of named) {
      const held = valueAt(vars, name, at);
      if (!held) continue;
      if (parse.test(rhs)) return { ...held, parsed: true };
      if (new RegExp(`^(?:await\\s+)?${name.replace(/\$/g, "\\$")}\\s*(?:as\\s+\\w[\\w<>\\[\\], ]*)?;?\\s*$`).test(rhs)) return held;
    }
    return null;
  };
  /** `end`: where the binding's scope closes (a function body, a loop); none for the rest of the file. */
  const bind = (name, index, value, end) => {
    if (!vars.has(name)) vars.set(name, []);
    vars.get(name).push({ index, value, end });
  };
  // Parameters and loop variables of the same name are other variables: they
  // hold nothing known, and only inside their function or loop. Bound first,
  // so an assignment inside that scope is scoped with them.
  for (const b of scopedBindings(text, python)) bind(b.name, b.index, null, b.end);
  for (const m of text.matchAll(assign)) {
    const index = m.index + m[0].length - 1;
    // Inside a scope that shadows the name, the assignment is to the inner variable.
    const shadow = (vars.get(m[1]) ?? []).filter((a) => a.end !== undefined && a.index < index && index < a.end)
      .sort((x, y) => x.end - y.end)[0];
    bind(m[1], index, valueOf(m.index + m[0].length), shadow?.end);
  }
  if (!python) {
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*/g)) {
      const value = valueOf(m.index + m[0].length);
      if (!value?.parsed || !value.json) continue;
      for (const part of splitTop(m[1], ",")) {
        const key = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
        if (key && !part.trim().startsWith("...")) reads.push(read(text, value.command, key, m.index));
      }
    }
  }
  for (const [name, assignments] of vars) {
    if (!assignments.some((a) => a.value?.parsed)) continue;
    const use = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?=\\??\\.|\\[)`, "g");
    for (const m of text.matchAll(use)) {
      const value = valueAt(vars, name, m.index);
      if (!value?.parsed || !value.json) continue;
      const path = chainPath(text.slice(m.index + name.length), python);
      if (path) reads.push(read(text, value.command, path, m.index));
    }
  }
  return reads.sort((a, b) => a.index - b.index).map(({ index: _, ...r }) => r);
}

function read(text, command, path, index) {
  const line = lineOf(text, index);
  return { command, path, line, snippet: text.split("\n")[line - 1].trim().slice(0, 100), index };
}

/** The value a variable held at `index`: its last binding before it whose scope is still open. */
function valueAt(vars, name, index) {
  let best;
  for (const a of vars.get(name) ?? []) {
    if (a.index < index && (a.end === undefined || index < a.end) && (!best || a.index >= best.index)) best = a;
  }
  return best?.value;
}

/** Skip a string or comment starting at `i`; the index just past it, or `i` when there is none. */
function skipLiteral(text, i, python) {
  const c = text[i];
  if (c === '"' || c === "'" || c === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === c) return j + 1;
      else if (text[j] === "\n" && c !== "`" && !python) return j;
    }
    return text.length;
  }
  if (python ? c === "#" : text.startsWith("//", i)) {
    const e = text.indexOf("\n", i);
    return e < 0 ? text.length : e;
  }
  if (!python && text.startsWith("/*", i)) {
    const e = text.indexOf("*/", i + 2);
    return e < 0 ? text.length : e + 2;
  }
  return i;
}

/**
 * Scan from `start` at bracket depth 0 to where an enclosing bracket closes
 * (its index), or, with `stops`, to the first of those characters at depth 0.
 */
function scanTo(text, start, python, stops = "") {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const skip = skipLiteral(text, i, python);
    if (skip !== i) { i = skip - 1; continue; }
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && stops.includes(c)) return i;
  }
  return text.length;
}

/** The end of a JS body starting at or after `from`: a `{…}` block, or a statement or expression. */
function jsBodyEnd(text, from) {
  const at = from + /^\s*/.exec(text.slice(from))[0].length;
  if (text[at] === "{") return Math.min(text.length, scanTo(text, at + 1, false) + 1);
  return scanTo(text, at, false, ",;");
}

/** The end of the indented Python block under the `def` at `def`, whose header ends at `from`. */
function pyBlockEnd(text, def, from) {
  const startOfLine = text.lastIndexOf("\n", def - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(startOfLine))[0].length;
  let pos = text.indexOf("\n", from);
  while (pos >= 0 && pos < text.length) {
    const next = text.indexOf("\n", pos + 1);
    const line = text.slice(pos + 1, next < 0 ? text.length : next);
    if (/\S/.test(line) && !/^\s*#/.test(line) && /^[ \t]*/.exec(line)[0].length <= indent) return pos + 1;
    if (next < 0) break;
    pos = next;
  }
  return text.length;
}

/**
 * The names a parameter list or a loop target binds: `a, b = 1`, `a: T`,
 * `...rest`, `*args`, and inside a destructuring pattern `{ a, b: c }` or
 * `[a, b]` the names it binds (`a`, `c`, `b`).
 */
function boundNames(list, pattern = false) {
  const names = [];
  for (const raw of splitTop(list, ",")) {
    let part = raw.trim();
    if (pattern) {
      // `key: target`: the target is what is bound.
      const renamed = /^[A-Za-z_$][\w$]*\s*:\s*([\s\S]*)$/.exec(part);
      if (renamed) part = renamed[1].trim();
    }
    if (/^[[({]/.test(part)) {
      const close = scanTo(part, 1, false);
      names.push(...boundNames(part.slice(1, close), part[0] !== "("));
      continue;
    }
    const name = /^(?:\.\.\.|\*{1,2})?([A-Za-z_$][\w$]*)/.exec(part)?.[1];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Bindings that make a name another variable: `[{ name, index, end }]`, `end`
 * undefined when it lasts to the end of the file.
 *   - JS: function, method, arrow and catch parameters, for the function body;
 *     `for (const x of …)` and `for (x in …)` variables, for the loop.
 *   - Python: `def` parameters, for the indented body; comprehension
 *     variables, for the brackets; and, to the end of the file, since Python
 *     has no block scope, `for x in` statement variables and `with … as x:`.
 */
function scopedBindings(text, python) {
  const out = [];
  const add = (names, index, end) => { for (const name of names) out.push({ name, index, end }); };
  if (python) {
    for (const m of text.matchAll(PY_PARAMS)) add(boundNames(m[2]), m.index, pyBlockEnd(text, m.index, m.index + m[0].length));
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_(][\w\s,()]*?)\s+in\b/g)) {
      const names = boundNames(m[1]);
      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      if (/^\s*(?:async\s+)?$/.test(text.slice(lineStart, m.index))) { add(names, m.index); continue; }
      // A comprehension: the variable lives inside its brackets.
      let depth = 0, open = -1;
      for (let i = m.index - 1; i >= 0; i--) {
        const c = text[i];
        if (")]}".includes(c)) depth++;
        else if ("([{".includes(c)) { if (depth === 0) { open = i; break; } depth--; }
      }
      if (open < 0) add(names, m.index);
      else add(names, open, scanTo(text, open + 1, true));
    }
    for (const m of text.matchAll(/\bas\s+([A-Za-z_]\w*)\s*:/g)) add([m[1]], m.index);
    return out;
  }
  for (const m of text.matchAll(JS_PARAMS)) {
    if (/^(?:if|for|while|switch|return)$/.test(m[1] ?? m[3] ?? "")) continue;
    const params = m[2] ?? m[4] ?? m[5] ?? m[6] ?? "";
    const end = m[0].endsWith("{")
      ? jsBodyEnd(text, m.index + m[0].length - 1)
      : m[0].endsWith("=>")
        ? jsBodyEnd(text, m.index + m[0].length)
        : jsBodyEnd(text, Math.max(m.index + m[0].length, text.indexOf("{", m.index + m[0].length)));
    add(boundNames(params), m.index, end);
  }
  for (const m of text.matchAll(/\bfor\s*(?:await\s*)?\(\s*(?:(?:const|let|var)\s+)?([[{][^\]}]*[\]}]|[A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) {
    const header = text.indexOf("(", m.index);
    const close = scanTo(text, header + 1, false);
    add(boundNames(m[1]), m.index, jsBodyEnd(text, close + 1));
  }
  return out;
}

/** `?.a.b[0]["c"]` or Python `["a"][0].get("b")` -> `a.b[].c`, up to a method call. */
function chainPath(rest, python) {
  let path = "";
  for (;;) {
    let m;
    if ((m = /^\??\.([A-Za-z_$][\w$]*)/.exec(rest))) {
      if (python && m[1] === "get") {
        const get = /^\.get\(\s*(["'])([^"']+)\1[^)]*\)/.exec(rest);
        if (!get) break;
        path = joinPath(path, get[2]);
        rest = rest.slice(get[0].length);
        continue;
      }
      if (CHAIN_END.has(m[1]) || /^\s*\(/.test(rest.slice(m[0].length))) break;
      path = joinPath(path, m[1]);
    } else if ((m = /^(?:\?\.)?\[\s*(["'])([^"']+)\1\s*\]/.exec(rest))) {
      path = joinPath(path, m[2]);
    } else if ((m = /^(?:\?\.)?\[\s*-?\d+\s*\]/.exec(rest))) {
      path = `${path}[]`;
    } else break;
    rest = rest.slice(m[0].length);
  }
  return path;
}

/** File extensions: a dotted token ending in one is a file name, not a field. */
const FILE_EXT = /\.(?:[cm]?[jt]sx?|py|md|mdc|json|ya?ml|toml|sh|bash|go|rs|java|kt|rb|php|c|h|cpp|cs|scala|txt|lock|cfg|ini|env|html|css|sql|xml)$/;

/** Words that, just before a dotted code span, make it a tool's argument (a qualified symbol name), not a read. */
const ARGUMENT_BEFORE = /\b(?:named|called|like|e\.g\.|i\.e\.|such as|symbol|function|method|class|module|argument|arg|target|pass|passing|(?:the|a|its) query)[\s:,]*$/i;
/**
 * Words that make a dotted span an argument only right after the tool's own
 * span (`ix_callers` on `a.b`, `ix_search` for `client.query`). Anywhere
 * else they are ordinary prose ("check for `traversal.nodes_visited`").
 */
const ARGUMENT_AFTER_TOOL = /^[\s,]*(?:on|for|with|query)[\s:,]*$/i;

/** A host name: `docs.example.com`. */
const HOST_NAME = /\.(?:com|org|net|io|dev|ai|app|co|edu|gov|sh)$/;

/**
 * MCP tool names and the fields text says to read from their results:
 * `[{ tool, line, snippet }]` for a tool named in a code span, and
 * `[{ tool, path, line, snippet }]` for a code span that is a JSON path
 * (`a.b`, `a[0]`, `.a`) after a tool in the same section. A heading or an
 * `ix …` command span ends the section.
 */
export function mcpReferences(text, ext = ".md") {
  if (ext === ".json") {
    let data;
    try { data = JSON.parse(text); } catch { return mcpReferences(text); }
    const found = [];
    const visit = (value, path) => {
      if (typeof value === "string") {
        for (const ref of mcpReferences(value)) found.push({ ...ref, line: `${path}:${ref.line}` });
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
      }
    };
    visit(data, "");
    return found;
  }
  const found = [];
  let tool = null;
  let inFence = false;
  text.replace(/\\`/g, "`").split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    if (/^\s{0,3}#{1,6}\s/.test(raw)) tool = null;
    const snippet = raw.trim().slice(0, 100);
    let after = 0;
    let argument = false;
    let toolSpan = false;
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      const before = raw.slice(after, m.index);
      after = m.index + m[0].length;
      // The next item of a list of arguments: `on `a.b`, `c.d` or `e.f``.
      const listed = argument && /^\s*(?:,|,?\s*(?:or|and))\s*$/.test(before);
      const afterTool = toolSpan && ARGUMENT_AFTER_TOOL.test(before);
      argument = false;
      toolSpan = false;
      const named = /^(ix_[a-z][a-z0-9_]*)(?=$|[\s(])/.exec(span);
      if (named) {
        tool = named[1];
        toolSpan = true;
        found.push({ tool, line: i + 1, snippet });
        continue;
      }
      // An `ix …` command: what follows is about the CLI's output, not a tool's.
      if (/^ix\s/.test(span)) { tool = null; continue; }
      if (!tool || /^ix/.test(span) || FILE_EXT.test(span)) continue;
      const plain = /^[a-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(span);
      if (plain && (listed || afterTool || ARGUMENT_BEFORE.test(before))) { argument = true; continue; }
      if (plain && HOST_NAME.test(span)) continue;
      const dotted = /^[a-z_][A-Za-z0-9_]*(?:\??\.[A-Za-z_][A-Za-z0-9_]*|\[\d*\])+$/.test(span);
      const jq = /^\.[A-Za-z_][A-Za-z0-9_]*(?:\??\.[A-Za-z_][A-Za-z0-9_]*|\[\d*\])*$/.test(span);
      if (dotted || jq) found.push({ tool, path: span.replace(/^\./, ""), line: i + 1, snippet });
    }
  });
  return found;
}

/**
 * The `ix_…` names a plugin defines itself, from one of its files: functions
 * (shell `ix_x() {` or `function ix_x`, Python `def ix_x`, JS `function ix_x`
 * or `const ix_x =`), the file's own path segments (`ix_lib.sh`, `ix_lib/`),
 * and the MCP tools it serves itself: a tool registered by name
 * (`name: "ix_x"`, `name="ix_x"`, `"name": "ix_x"`, `server.tool("ix_x"`,
 * `registerTool("ix_x"`) or keyed by it in a table (`ix_x: {`).
 */
export function definedHelpers(text, file) {
  const names = new Set();
  for (const segment of file.split(/[\\/]/)) {
    const named = /^(ix_[a-z0-9_]+)(?:\.[^/]*)?$/i.exec(segment);
    if (named) names.add(named[1]);
  }
  const definition = /(?:^|[\s;{(])(?:(?:function|def)\s+(ix_[a-z0-9_]+)\b|(?:const|let|var)\s+(ix_[a-z0-9_]+)\s*=|(ix_[a-z0-9_]+)\s*\(\s*\)\s*\{)/gm;
  for (const m of text.matchAll(definition)) names.add(m[1] ?? m[2] ?? m[3]);
  const served = [
    // name: "ix_x", name="ix_x", "name": "ix_x", tool_name = 'ix_x'
    /\b(?:tool_?)?name["']?\s*[:=]\s*["'`](ix_[a-z0-9_]+)["'`]/gi,
    // server.tool("ix_x", …), registerTool("ix_x", …), add_tool('ix_x'), defineTool(`ix_x`)
    /\b(?:tool|register_?tool|add_?tool|define_?tool)\s*\(\s*["'`](ix_[a-z0-9_]+)["'`]/gi,
    // a tool table: { ix_x: { … } } or { "ix_x": { … } }
    /(?:^|[\s{,])["']?(ix_[a-z0-9_]+)["']?\s*:\s*\{/gm,
  ];
  for (const re of served) for (const m of text.matchAll(re)) names.add(m[1]);
  return names;
}

/** An `ix_<cmd>_json` wrapper: the shell form shellInvocations reads as `ix <cmd> --format json`. */
const JSON_WRAPPER = /^ix_[a-z]+_json$/;

/**
 * What is wrong with one MCP reference, or null. `helpers` are the `ix_…`
 * names the plugin defines itself (definedHelpers): naming one is not naming
 * an `ix mcp` tool, and a field read after one is a read from the plugin's own
 * function or tool, whose output this CLI does not define, so it is not checked
 * either, even when `ix mcp` serves a tool of the same name.
 */
export function checkMcp(ref, mcp, helpers = new Set()) {
  if (helpers.has(ref.tool)) return null;
  if (ref.path === undefined) {
    if (mcp.tools.has(ref.tool) || JSON_WRAPPER.test(ref.tool)) return null;
    return `unknown MCP tool "${ref.tool}"`;
  }
  if (!mcp.tools.has(ref.tool) || mcp.jsonResults.has(ref.tool)) return null;
  return `"${ref.tool}" returns \`--format llm\` records, not JSON: it has no field "${ref.path}"`;
}

async function main(argv) {
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
  let pro;
  try {
    pro = await loadProSurface();
  } catch (err) {
    console.error(`cannot load the Pro surface from dist/: run 'npm run build' in ix-cli first.\n${err}`);
    return 2;
  }
  let fields;
  try {
    fields = await loadFieldSurface();
  } catch (err) {
    console.error(`cannot load the field lists or the MCP catalog from dist/: run 'npm run build' in ix-cli first.\n${err}`);
    return 2;
  }
  const commands = new Set(surface.keys());
  const ignores = loadIgnores();
  const problems = [];
  const counts = { invocations: 0, reads: 0, mcp: 0 };
  for (const repo of PLUGINS) {
    const root = join(dir, repo);
    try { statSync(root); } catch { console.error(`missing ${root}`); return 2; }
    // The plugin's own ix_… helpers and the MCP tools it serves itself, so its
    // docs may name them and read their fields.
    const helpers = new Set();
    for (const file of walk(root)) {
      const ext = extname(file);
      const text = CODE_EXT.has(ext) || SHELL_EXT.has(ext) ? readFileSync(file, "utf8") : "";
      for (const name of definedHelpers(text, relative(root, file))) helpers.add(name);
    }
    for (const file of walk(root)) {
      const ext = extname(file);
      if (!CODE_EXT.has(ext) && !TEXT_EXT.has(ext) && !SHELL_EXT.has(ext)) continue;
      if (HISTORICAL.test(file)) continue;
      const text = readFileSync(file, "utf8");
      // Case-insensitive: `runIx([...])` is an invocation with no lowercase "ix".
      if (!/ix/i.test(text)) continue;
      const report = (line, snippet, problem) => {
        if (!problem) return;
        const where = `${repo}/${relative(root, file)}:${line}`;
        if (ignores.some((ig) => where.startsWith(ig.where) && (!ig.match || snippet.includes(ig.match)))) return;
        problems.push(`${where}  ${problem}\n    ${snippet}`);
      };
      if (!SHELL_EXT.has(ext)) {
        const invocations = [
          ...(CODE_EXT.has(ext) ? codeInvocations(text) : []),
          ...(ext === ".json" ? jsonInvocations(text) : textInvocations(text)),
        ];
        for (const inv of invocations) {
          counts.invocations++;
          report(inv.line, inv.snippet, check(inv.argv, surface, pro));
        }
      }
      for (const read of fieldReads(text, file, commands)) {
        counts.reads++;
        report(read.line, read.snippet, checkField(read.command, read.path, fields));
      }
      if (TEXT_EXT.has(ext)) {
        for (const ref of mcpReferences(text, ext)) {
          counts.mcp++;
          report(ref.line, ref.snippet, checkMcp(ref, fields.mcp, helpers));
        }
      }
    }
  }
  console.log(`checked ${counts.invocations} ix invocations, ${counts.reads} output field reads and ${counts.mcp} MCP references in ${PLUGINS.length} plugins`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s): a command, flag, output field or MCP name this CLI does not have:\n\n${problems.join("\n")}`);
    console.error(`\nA false positive (prompt prose, a placeholder) goes in scripts/plugin-contract-ignore.json; see the header of this script.`);
    return 1;
  }
  return 0;
}

// Run as a script, not when a test imports it. Real paths, so a symlinked
// invocation still runs the check rather than exiting 0 having checked nothing.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exit(await main(process.argv.slice(2)));
