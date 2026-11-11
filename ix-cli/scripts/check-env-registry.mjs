#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

/**
 * Environment-variable registry gate (#948).
 *
 * `ENV_VARS` in src/cli/env.ts is the one list of the `IX_*` variables the CLI
 * reads. This script checks the code and the docs against it:
 *
 *   - every `IX_*` name that appears in ix-cli/src (outside tests) is either
 *     registered or listed in NOT_VARIABLES below, with the reason it is not a
 *     variable the CLI reads (a constant's identifier, another program's
 *     variable);
 *   - every registered name still appears in ix-cli/src, so a variable the
 *     code stopped reading does not stay documented;
 *   - the table of public variables on the configuration reference, between
 *     the `<!-- env-vars:… -->` markers, is exactly what `renderEnvTable`
 *     makes from the registry (`--write` regenerates it).
 *
 * The registry is TypeScript, so the command-line run reads the built copy
 * (dist/cli/env.js), as check-doc-parity.mjs does. Run from ix-cli:
 *
 *   npm run build
 *   node scripts/check-env-registry.mjs          # check; exit 1 on drift
 *   node scripts/check-env-registry.mjs --write  # regenerate the table, then check
 *
 * check-env-registry.test.mjs runs the same check against src/cli/env.ts as
 * part of `npm run test:unit`, so an unregistered variable fails CI.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_ROOT = join(here, "..");
export const REPO_ROOT = join(CLI_ROOT, "..");

/** Repo-relative path of the page that carries the generated table. */
export const DOC_PATH = "docs-site/src/content/docs/reference/configuration.md";

export const TABLE_START =
  "<!-- env-vars:start (generated from ix-cli/src/cli/env.ts by ix-cli/scripts/check-env-registry.mjs --write) -->";
export const TABLE_END = "<!-- env-vars:end -->";

/**
 * `IX_*` names in the source that are not environment variables the CLI
 * reads, and why. Anything else that looks like one must be registered.
 */
export const NOT_VARIABLES = {
  IX_CALLER_ENV: "constant holding the name IX_CALLER",
  IX_COMPOSE_PROJECTS: "constant: Compose project names",
  IX_MCP_CORE_TOOL_NAMES: "constant: MCP tool list",
  IX_MCP_INSTRUCTIONS: "constant: MCP server instructions",
  IX_MCP_OSS_TOOL_NAMES: "constant: MCP tool list",
  IX_MCP_PRO_TOOL_NAMES: "constant: MCP tool list",
  IX_MCP_TOOL_NAMES: "constant: MCP tool list",
  IX_ISSUE_START_TIMEOUT: "read by the Claude plugin's briefing, not by the CLI; named in a comment",
  IX_BULK_MAX_BODY_MB: "the backend's variable, not the CLI's; named in a comment",
};

const NAME = /\bIX_[A-Z0-9_]{3,}\b/g;

/** Source files the gate reads: src/**\/*.ts, without tests. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every `IX_*` name in ix-cli/src and where it appears, as
 * `Map<name, string[]>` of `path:line` (paths relative to ix-cli).
 */
export function scanSource(srcDir = join(CLI_ROOT, "src")) {
  const uses = new Map();
  for (const file of sourceFiles(srcDir).sort()) {
    const rel = relative(CLI_ROOT, file).split(sep).join("/");
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const [name] of line.matchAll(NAME)) {
        if (!uses.has(name)) uses.set(name, []);
        uses.get(name).push(`${rel}:${i + 1}`);
      }
    });
  }
  return uses;
}

const escapeCell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The default as the table shows it. */
export function defaultText(spec) {
  if (spec.defaultText !== undefined) return spec.defaultText;
  if (spec.type === "flag") return spec.default === undefined ? "unset" : spec.default ? "on" : "off";
  if (spec.default !== undefined) return String(spec.default);
  return "unset";
}

/** The type as the table shows it. */
export function typeText(spec) {
  if (spec.type === "enum") return spec.values.map((v) => `\`${v}\``).join(", ");
  return spec.type;
}

/** The markdown table of public variables, markers included. */
export function renderEnvTable(registry) {
  const rows = Object.entries(registry)
    .filter(([, spec]) => spec.visibility === "public")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) =>
      `| \`${name}\` | ${escapeCell(typeText(spec))} | ${escapeCell(defaultText(spec))} | ${escapeCell(spec.description)} |`);
  return [
    TABLE_START,
    "| Variable | Type | Default | Effect |",
    "|---|---|---|---|",
    ...rows,
    TABLE_END,
  ].join("\n");
}

/** The doc's text between (and including) the markers, or null without them. */
export function documentedTable(doc) {
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) return null;
  return doc.slice(start, end + TABLE_END.length);
}

/** The doc with its table replaced by the registry's. */
export function regenerate(doc, registry) {
  const current = documentedTable(doc);
  if (current === null) throw new Error(`${DOC_PATH} has no ${TABLE_START} … ${TABLE_END} markers`);
  return doc.replace(current, renderEnvTable(registry));
}

/** Every way the code or the docs disagree with the registry; [] when none. */
export function collectProblems({ registry, uses, doc }) {
  const problems = [];
  for (const [name, where] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    if (Object.hasOwn(registry, name) || Object.hasOwn(NOT_VARIABLES, name)) continue;
    problems.push(
      `${name} is used in ${where.slice(0, 3).join(", ")}${where.length > 3 ? ", …" : ""} but is not ` +
        `registered: add it to ENV_VARS in src/cli/env.ts (or, if it is not an environment variable, ` +
        `to NOT_VARIABLES in scripts/check-env-registry.mjs).`,
    );
  }
  for (const name of Object.keys(registry).sort()) {
    if (!uses.has(name)) {
      problems.push(`${name} is registered in src/cli/env.ts but nothing in ix-cli/src mentions it: remove it.`);
    }
  }
  for (const name of Object.keys(NOT_VARIABLES).sort()) {
    if (Object.hasOwn(registry, name)) problems.push(`${name} is both registered and in NOT_VARIABLES.`);
  }
  const table = documentedTable(doc);
  if (table === null) {
    problems.push(`${DOC_PATH} has no ${TABLE_START} … ${TABLE_END} markers.`);
  } else if (table !== renderEnvTable(registry)) {
    problems.push(
      `The environment-variable table in ${DOC_PATH} is out of date: run ` +
        "`npm run build && node scripts/check-env-registry.mjs --write` from ix-cli.",
    );
  }
  return problems;
}

/** The page's current text. */
export function readDoc() {
  return readFileSync(join(REPO_ROOT, DOC_PATH), "utf8");
}

async function main() {
  const built = join(CLI_ROOT, "dist", "cli", "env.js");
  if (!existsSync(built)) {
    console.error("dist/cli/env.js is missing: run `npm run build` in ix-cli first.");
    process.exit(1);
  }
  const { ENV_VARS } = await import(pathToFileURL(built).href);
  let doc = readDoc();
  if (process.argv.includes("--write")) {
    doc = regenerate(doc, ENV_VARS);
    writeFileSync(join(REPO_ROOT, DOC_PATH), doc);
  }
  const problems = collectProblems({ registry: ENV_VARS, uses: scanSource(), doc });
  if (problems.length > 0) {
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`env registry: ${Object.keys(ENV_VARS).length} variables, code and docs agree.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
