#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

/**
 * Render the workflow skills (skills/workflows/*.md) for each host plugin.
 *
 * One template per workflow, rendered per host from skills/hosts.json. The
 * plugins used to carry hand-kept copies that drifted apart: one dialect tells
 * the agent to run `ix impact X --format llm`, the other to call the `ix_impact`
 * tool, and each copy quoted field names of its own. A template states the call
 * once and each host gets its dialect.
 *
 *   node scripts/render-skills.mjs --out <dir> [--host <id>]
 *
 * writes <dir>/<host>/skills/<name>/SKILL.md for every skill each host lists.
 * This does not touch skills/ix or `ix install`, which ship a different skill.
 *
 * Template syntax. Everything outside {{...}} is copied as is, and any {{...}}
 * not listed here is an error, so a typo cannot ship.
 *
 *   {{ix <command> <name>=<value> ...}}
 *       One call, inline. The first pair is the command's positional argument;
 *       the rest are options. Values are bare (up to whitespace) or "quoted"
 *       (JSON string rules); an integer stays a number over MCP.
 *         cli:  `ix callers $ARGUMENTS --limit 15 --format llm`
 *         mcp:  `ix_callers` with `{ "symbol": "$ARGUMENTS", "limit": 15 }`
 *       The names are the `ix mcp` tool's parameter names; a name_with_underscores
 *       is the --name-with-hyphens flag on the CLI.
 *
 *   {{ix <command>}}
 *       The command's name only: `ix imported-by` / `ix_imported_by`.
 *
 *   {{calls}}
 *   ix <command> <name>=<value> ...
 *   {{/calls}}
 *       Calls on their own lines (no braces): a ```bash fence for cli, a
 *       bullet list for mcp. Both tag lines must stand alone.
 *
 *   {{preamble}}
 *       On a line of its own: the host's `preamble` lines and a blank line, or
 *       nothing. For host-only lines that link to files only that host's plugin
 *       has. They live in hosts.json because in a template such a link would be
 *       broken in this repo (check-links scans every tracked .md).
 *
 *   {{#if cli}} ... {{/if}}   {{#if mcp}} ... {{/if}}   {{#if host=<id>}} ... {{/if}}
 *       Kept only for that dialect or host. When both tags stand alone on their
 *       lines the tag lines go too; otherwise it works inside a line. No nesting.
 *
 * Front matter: the template's `---` block is kept, line for line, with the
 * host's `frontmatter` keys set over it (null removes a key).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const DIALECTS = new Set(["cli", "mcp"]);
/** `ix mcp serve --tools` sets (ToolsetName in src/mcp/server.ts). */
const EXPOSURES = new Set(["core", "all"]);
/**
 * What `--tools=core` advertises: IX_MCP_CORE_TOOL_NAMES, plus the Pro tools,
 * which the core gate exempts (both in src/mcp/server.ts; render-skills.test.mjs
 * fails if these drift from it). A skill for a core host may call nothing else.
 */
export const CORE_TOOLS = new Set(["ix_context", "ix_search", "ix_neighbors", "ix_impact", "ix_read"]);
export const PRO_TOOLS = new Set(["ix_briefing", "ix_decisions", "ix_decide"]);
const HOST_KEYS = new Set(["dialect", "exposure", "skills", "frontmatter", "preamble"]);

class TemplateError extends Error {}

// ── calls ────────────────────────────────────────────────────────────────────

const PAIR = /^([A-Za-z][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/;

/** Parse `<command> name=value ...` (the text after `ix `). */
function parseCall(text) {
  const command = text.match(/^[a-z][a-z0-9-]*/)?.[0];
  if (!command) throw new TemplateError(`a call needs a command: "ix ${text}"`);
  let rest = text.slice(command.length);
  const args = [];
  while ((rest = rest.trimStart())) {
    const m = rest.match(PAIR);
    if (!m) throw new TemplateError(`"ix ${text}": expected name=value at "${rest}"`);
    const [whole, name, quoted, bare] = m;
    if (args.some(([n]) => n === name)) throw new TemplateError(`"ix ${text}": ${name} given twice`);
    const value = quoted !== undefined ? JSON.parse(`"${quoted}"`) : /^-?\d+$/.test(bare) ? Number(bare) : bare;
    args.push([name, value]);
    rest = rest.slice(whole.length);
  }
  return { command, args };
}

/** The argv the cli dialect's form of a call runs (without the leading `ix`). */
export function cliArgv({ command, args }) {
  const argv = [command];
  args.forEach(([name, value], i) => {
    if (i > 0) argv.push(`--${name.replace(/_/g, "-")}`);
    argv.push(String(value));
  });
  if (args.length > 0) argv.push("--format", "llm");
  return argv;
}

const shellWord = (s) => (/^[\w$./:@%+=,-]+$/.test(s) ? s : JSON.stringify(s));
const toolName = (command) => `ix_${command.replace(/-/g, "_")}`;

function cliLine(call) {
  return ["ix", ...cliArgv(call).map(shellWord)].join(" ");
}

function mcpCall({ command, args }) {
  const tool = `\`${toolName(command)}\``;
  if (args.length === 0) return tool;
  const json = args.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(", ");
  return `${tool} with \`{ ${json} }\``;
}

function inlineCall(call, dialect) {
  return dialect === "cli" ? `\`${cliLine(call)}\`` : mcpCall(call);
}

// ── conditionals ─────────────────────────────────────────────────────────────

const IF_OPEN = /\{\{#if ([^}]*)\}\}/;

function holds(condition, host) {
  if (DIALECTS.has(condition)) return host.dialect === condition;
  const m = condition.match(/^host=([a-z0-9-]+)$/);
  if (m) return host.id === m[1];
  throw new TemplateError(`unknown condition "{{#if ${condition}}}" (cli, mcp or host=<id>)`);
}

function applyConditionals(text, host) {
  let out = "";
  let rest = text;
  for (let open = rest.match(IF_OPEN); open; open = rest.match(IF_OPEN)) {
    const start = open.index;
    const bodyStart = start + open[0].length;
    const close = rest.indexOf("{{/if}}", bodyStart);
    if (close < 0) throw new TemplateError(`unclosed "${open[0]}"`);
    const body = rest.slice(bodyStart, close);
    if (IF_OPEN.test(body)) throw new TemplateError(`"${open[0]}" cannot nest another {{#if}}`);
    const keep = holds(open[1].trim(), host);
    const end = close + "{{/if}}".length;
    const lineStart = start === 0 || rest[start - 1] === "\n";
    const block = lineStart && rest[bodyStart] === "\n" && rest[close - 1] === "\n" && (rest[end] === "\n" || end === rest.length);
    if (block) {
      // Tags alone on their lines: drop those lines along with the tags.
      out += rest.slice(0, start) + (keep ? body.slice(1) : "");
      rest = rest.slice(end + (rest[end] === "\n" ? 1 : 0));
    } else {
      out += rest.slice(0, start) + (keep ? body : "");
      rest = rest.slice(end);
    }
  }
  if (rest.includes("{{/if}}")) throw new TemplateError("{{/if}} without {{#if}}");
  return out + rest;
}

// ── front matter ─────────────────────────────────────────────────────────────

function applyFrontmatter(text, overrides) {
  const m = text.match(/^---\n([\s\S]*?\n)?---\n/);
  if (!m) {
    if (Object.keys(overrides).length > 0) throw new TemplateError("host front matter given but the template has none");
    return text;
  }
  // Each entry is a top-level `key:` line plus any indented lines under it.
  const entries = [];
  for (const line of (m[1] ?? "").split("\n").slice(0, -1)) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key) entries.push({ key, lines: [line] });
    else if (entries.length > 0) entries.at(-1).lines.push(line);
    else throw new TemplateError(`front matter line without a key: "${line}"`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    const i = entries.findIndex((e) => e.key === key);
    if (value === null) {
      if (i >= 0) entries.splice(i, 1);
      continue;
    }
    if (typeof value !== "string" || value.includes("\n")) throw new TemplateError(`front matter ${key}: a one-line string or null`);
    const entry = { key, lines: [`${key}: ${value}`] };
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
  }
  const body = entries.flatMap((e) => e.lines).map((l) => `${l}\n`).join("");
  return `---\n${body}---\n${text.slice(m[0].length)}`;
}

// ── render ───────────────────────────────────────────────────────────────────

/**
 * Render one template for one host ({ id, dialect, exposure?, frontmatter?, preamble? }).
 * `onCall` sees every call that survives the host's conditionals.
 */
export function renderSkill(source, host, { onCall } = {}) {
  if (!DIALECTS.has(host.dialect)) throw new TemplateError(`host ${host.id}: unknown dialect "${host.dialect}" (cli or mcp)`);
  const dialect = host.dialect;
  const seen = (call) => {
    if (dialect === "mcp" && host.exposure === "core") {
      const tool = toolName(call.command);
      if (!CORE_TOOLS.has(tool) && !PRO_TOOLS.has(tool)) {
        throw new TemplateError(`host ${host.id} registers \`ix mcp --tools=core\`, which has no ${tool}`);
      }
    }
    onCall?.(call);
    return call;
  };
  let text = applyConditionals(source.replace(/\r\n/g, "\n"), host);

  text = text.replace(/^\{\{preamble\}\}\n/gm, () => (host.preamble ? `${host.preamble.replace(/\n+$/, "")}\n\n` : ""));

  text = text.replace(/^\{\{calls\}\}\n([\s\S]*?)^\{\{\/calls\}\}\n?/gm, (_, body) => {
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) throw new TemplateError("empty {{calls}} block");
    const calls = lines.map((l) => {
      const t = l.trim();
      if (!t.startsWith("ix ")) throw new TemplateError(`a {{calls}} line must start with "ix ": "${t}"`);
      return seen(parseCall(t.slice(3)));
    });
    return dialect === "cli"
      ? `\`\`\`bash\n${calls.map(cliLine).join("\n")}\n\`\`\`\n`
      : `${calls.map((c) => `- ${mcpCall(c)}`).join("\n")}\n`;
  });

  text = text.replace(/\{\{ix(?: ([^}]*))?\}\}/g, (_, inner) => inlineCall(seen(parseCall((inner ?? "").trim())), dialect));

  const leftover = text.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new TemplateError(`unknown directive "${leftover[0]}"`);

  return applyFrontmatter(text, host.frontmatter ?? {});
}

/** Read and check hosts.json. */
export function loadHosts(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const hosts = parsed?.hosts;
  if (!hosts || typeof hosts !== "object") throw new TemplateError(`${path}: no "hosts" object`);
  for (const [id, host] of Object.entries(hosts)) {
    for (const key of Object.keys(host)) {
      if (!HOST_KEYS.has(key)) throw new TemplateError(`${path}: host ${id} has unknown key "${key}"`);
    }
    if (!DIALECTS.has(host.dialect)) throw new TemplateError(`${path}: host ${id}: dialect must be cli or mcp`);
    if (host.dialect === "mcp" && !EXPOSURES.has(host.exposure)) {
      throw new TemplateError(`${path}: host ${id}: an mcp host needs exposure core or all (its \`ix mcp serve --tools\` set)`);
    }
    if (!Array.isArray(host.skills)) throw new TemplateError(`${path}: host ${id}: skills must be a list`);
    if (host.preamble !== undefined && typeof host.preamble !== "string") {
      throw new TemplateError(`${path}: host ${id}: preamble must be a string`);
    }
  }
  return { hosts };
}

/** Render every host's skills under outDir; returns the paths written. */
export function renderAll({ hostsPath, workflowsDir, outDir, only }) {
  const { hosts } = loadHosts(hostsPath);
  if (only !== undefined && !(only in hosts)) throw new TemplateError(`no host "${only}" in ${hostsPath}`);
  const rendered = [];
  // Render everything before writing anything, so an error leaves no partial tree.
  for (const [id, host] of Object.entries(hosts)) {
    if (only !== undefined && id !== only) continue;
    for (const skill of host.skills) {
      let source;
      try {
        source = readFileSync(join(workflowsDir, `${skill}.md`), "utf8");
      } catch {
        throw new TemplateError(`host ${id}: no template for skill "${skill}" in ${workflowsDir}`);
      }
      try {
        rendered.push([join(outDir, id, "skills", skill, "SKILL.md"), renderSkill(source, { id, ...host })]);
      } catch (err) {
        if (err instanceof TemplateError) throw new TemplateError(`${skill}.md for ${id}: ${err.message}`);
        throw err;
      }
    }
  }
  for (const [path, text] of rendered) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return rendered.map(([path]) => path);
}

function main(argv) {
  const opts = { hostsPath: join(repoRoot, "skills", "hosts.json"), workflowsDir: join(repoRoot, "skills", "workflows") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.outDir = resolve(argv[++i] ?? "");
    else if (a === "--host") opts.only = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/render-skills.mjs --out <dir> [--host <id>]");
      return 0;
    } else {
      console.error(`render-skills: unknown argument "${a}"`);
      return 2;
    }
  }
  if (!opts.outDir) {
    console.error("render-skills: --out <dir> is required");
    return 2;
  }
  try {
    for (const path of renderAll(opts)) console.log(path);
    return 0;
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    console.error(`render-skills: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
