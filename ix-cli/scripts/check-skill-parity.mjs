// Copyright 2026 Ix Infrastructure Inc.

/**
 * Parity for the rendered workflow skills (skills/workflows/*.md, #995).
 *
 * check-doc-parity.mjs runs this after its flag-reference check. It renders
 * every skill each host in skills/hosts.json ships (scripts/render-skills.mjs),
 * plus any template no host lists yet, once per dialect, and checks the text
 * an agent will read:
 *
 *   - commands and flags: every `ix …` code span, and every `ix …` line of a
 *     fenced block, names a registered command (aliases count) or a Pro one,
 *     with long flags that command registers. A retired Pro name fails. Same
 *     rules as the plugin contract check (check-plugin-contract.mjs `check`).
 *   - MCP tools and arguments: every `ix_…` code span is a tool `ix mcp`
 *     serves, advertised under the host's `--tools` set, and the argument
 *     names after it (`ix_x` with `{ "a": 1 }`) are in its input schema. A Pro
 *     tool is accepted by name; this build cannot see its schema.
 *   - output fields: a record named as "the `impact` record", a field written
 *     `risk=` or `behavior text=`, and a field compared with a number
 *     (`callees` > 20) must appear in the CLI's recorded `--format llm`
 *     output: the vitest snapshots under src/cli/__tests__/__snapshots__,
 *     plus UNSNAPSHOTTED_FIELDS below. A field is checked against the record
 *     the text ties it to ("`nodes=` on the `depends` record", or the one
 *     record its line names); otherwise against every record.
 *
 * Not checked: JSON field names (`openBugs`), positional arguments, and the
 * flags of Pro commands, which this build does not register.
 *
 * Everything that reads the build lives in the caller: the functions here take
 * the modules they check against, so the tests run them on src/.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { check, textInvocations } from "./check-plugin-contract.mjs";
import { loadHosts, renderSkill } from "./render-skills.mjs";

/**
 * Records and fields the CLI prints that no snapshot records yet. Each entry
 * names the file that prints it; check-skill-parity.test.mjs fails if one is
 * no longer there.
 *
 * TODO(#995): drop each entry once a plugin-facing snapshot
 * (src/cli/__tests__/plugin-output.test.ts) records that command's
 * `--format llm` output; `ix explain` and `ix depends` have none yet, and
 * `ix impact`'s covers a function target, not a file or class.
 */
export const UNSNAPSHOTTED_FIELDS = {
  // `ix explain`, src/cli/explain/llm.ts
  edges: {
    source: "src/cli/explain/llm.ts",
    fields: ["callers", "callees", "dependents", "importers", "members", "downstream", "depth", "history", "complete"],
  },
  // `ix depends`, src/cli/commands/depends.ts
  depends: {
    source: "src/cli/commands/depends.ts",
    fields: ["target", "kind", "target_id", "semantics", "nodes", "depth", "truncated", "depth_limited"],
  },
  // `ix impact` on a file or class, src/cli/commands/impact.ts
  counts: { source: "src/cli/commands/impact.ts", fields: ["dependents"] },
};

// ── the surface ──────────────────────────────────────────────────────────────

/**
 * Registered commands keyed without the leading `ix` ("callers",
 * "docker start"), each alias too, in the shape check-plugin-contract's
 * `check` reads: `{ flags, subcommands }`.
 */
export function commandSurface(program) {
  const commands = new Map();
  const walk = (cmd, prefix) => {
    const names = [cmd.name(), ...(cmd.aliases?.() ?? [])];
    const entry = {
      flags: new Set((cmd.options ?? []).map((o) => o.long).filter(Boolean)),
      subcommands: new Set((cmd.commands ?? []).flatMap((c) => [c.name(), ...(c.aliases?.() ?? [])])),
    };
    for (const name of names) {
      const key = prefix ? `${prefix} ${name}` : name;
      commands.set(key, entry);
      for (const sub of cmd.commands ?? []) walk(sub, key);
    }
  };
  for (const cmd of program.commands) walk(cmd, "");
  return commands;
}

/** Tools `ix mcp --tools=<exposure>` advertises: name -> its input schema's argument names. */
export async function toolSurface(createIxMcpServer, exposure) {
  const server = createIxMcpServer({
    version: "0.0.0",
    tools: exposure,
    // Never called: listing tools runs nothing.
    runIx: async () => ({ ok: true, stdout: "", stderr: "" }),
  });
  const client = new Client({ name: "check-skill-parity", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]));
  } finally {
    await client.close();
  }
}

/** Unescape a vitest snapshot's template literal body. */
const unsnap = (text) => text.replace(/\\([\\`$])/g, "$1");

const RECORD_LINE = /^([a-z][a-z0-9_]*)((?: [a-z][a-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|\S*))+)$/;
const RECORD_PAIR = / ([a-z][a-z0-9_]*)=(?:"(?:[^"\\]|\\.)*"|\S*)/g;

/** `--format llm` records in snapshot text: record name -> its field names. */
export function recordedFields(texts) {
  const records = new Map();
  for (const text of texts) {
    for (const raw of unsnap(text).split("\n")) {
      // A snapshot's first and last lines carry the quotes vitest wraps the
      // string in; a record's own last value can end in a quote too.
      const trimmed = raw.replace(/^"/, "");
      const m = RECORD_LINE.exec(trimmed) ?? RECORD_LINE.exec(trimmed.replace(/"$/, ""));
      if (!m) continue;
      if (!records.has(m[1])) records.set(m[1], new Set());
      for (const pair of m[2].matchAll(RECORD_PAIR)) records.get(m[1]).add(pair[1]);
    }
  }
  return records;
}

/** Snapshot files under `dir`, read. */
export function readSnapshots(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".snap"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

/**
 * Everything the check compares against. `oss` is register/oss's module,
 * `server` mcp/server's, `pro` register/pro-surface's (from dist/ or src/).
 */
export async function loadSkillSurface({ oss, server, pro, Command, snapshots }) {
  const program = new Command();
  program.name("ix");
  oss.registerOssCommands(program);
  const fields = recordedFields(snapshots);
  for (const [record, { fields: names }] of Object.entries(UNSNAPSHOTTED_FIELDS)) {
    if (!fields.has(record)) fields.set(record, new Set());
    for (const f of names) fields.get(record).add(f);
  }
  return {
    commands: commandSurface(program),
    pro: { commands: new Set(pro.PRO_COMMAND_NAMES), retired: new Map(Object.entries(pro.PRO_RETIRED)) },
    proTools: new Set(pro.PRO_MCP_TOOL_NAMES),
    tools: {
      core: await toolSurface(server.createIxMcpServer, "core"),
      all: await toolSurface(server.createIxMcpServer, "all"),
    },
    fields,
  };
}

// ── what the text names ──────────────────────────────────────────────────────

const NAME = "[a-z][a-z0-9_]*";
const TOOL_SPAN = new RegExp(`\`(ix_${NAME})\`(?: with \`(\\{[^\`]*\\})\`)?`, "g");
const RECORD_MENTION = new RegExp(`\`(${NAME})\` records?\\b`, "g");
const FIELD_ON_RECORD = new RegExp(`\`(${NAME})=\` (?:on|in|of) the \`(${NAME})\` record\\b`, "g");
const RECORD_FIELD = new RegExp(`\`(${NAME}) (${NAME})=\``, "g");
const FIELD = new RegExp(`\`(${NAME})=\``, "g");
const COMPARED = new RegExp(`\`(${NAME})\`\\s*(?:[<>]=?|[=!]=)\\s*-?\\d`, "g");

/**
 * MCP tool and output field references in rendered text, by line:
 * `{ tools: [{ tool, args, line, snippet }], fields: [{ record, field, line, snippet }] }`.
 * `args` is null for a bare tool name; a field's `record` is null when the
 * text does not tie it to one.
 */
export function skillReferences(text) {
  const tools = [];
  const fields = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const snippet = raw.trim().slice(0, 100);
    for (const m of raw.matchAll(TOOL_SPAN)) {
      let args = null;
      if (m[2] !== undefined) {
        try {
          args = Object.keys(JSON.parse(m[2]));
        } catch {
          args = undefined; // not JSON: reported as such
        }
      }
      tools.push({ tool: m[1], args, line, snippet });
    }
    const records = [...raw.matchAll(RECORD_MENTION)].map((m) => m[1]);
    for (const record of records) fields.push({ record, field: null, line, snippet });
    // A field tied to a record by the text, then the rest: under the line's
    // one record when it names exactly one, otherwise under any.
    const tied = new Set();
    for (const m of raw.matchAll(FIELD_ON_RECORD)) {
      fields.push({ record: m[2], field: m[1], line, snippet });
      tied.add(m.index);
    }
    for (const m of raw.matchAll(RECORD_FIELD)) fields.push({ record: m[1], field: m[2], line, snippet });
    const only = new Set(records).size === 1 ? records[0] : null;
    for (const re of [FIELD, COMPARED]) {
      for (const m of raw.matchAll(re)) {
        if (!tied.has(m.index)) fields.push({ record: only, field: m[1], line, snippet });
      }
    }
  });
  return { tools, fields };
}

// ── checks ───────────────────────────────────────────────────────────────────

/** What is wrong with one tool reference under `exposure`, or null. */
export function checkTool(ref, surface, exposure = "all") {
  if (ref.args === undefined) return `"${ref.tool}": its arguments are not a JSON object`;
  const advertised = surface.tools[exposure].get(ref.tool);
  if (!advertised) {
    if (surface.proTools.has(ref.tool)) return null; // Pro: served when Pro is installed
    if (surface.tools.all.has(ref.tool)) return `"${ref.tool}" is not served under \`ix mcp --tools=${exposure}\``;
    return `unknown MCP tool "${ref.tool}"`;
  }
  const bad = (ref.args ?? []).filter((a) => !advertised.has(a));
  return bad.length ? `"${ref.tool}" has no argument ${bad.map((a) => `"${a}"`).join(", ")}` : null;
}

/** What is wrong with one field reference, or null. */
export function checkFieldRef(ref, surface) {
  const { fields } = surface;
  if (ref.record !== null && !fields.has(ref.record)) return `no recorded output has a "${ref.record}" record`;
  if (ref.field === null) return null;
  if (ref.record !== null) {
    return fields.get(ref.record).has(ref.field) ? null : `the "${ref.record}" record has no field "${ref.field}"`;
  }
  for (const names of fields.values()) if (names.has(ref.field)) return null;
  return `no recorded output has a field "${ref.field}"`;
}

/** Problems in one rendered skill, each `{ line, snippet, problem }`, and what was checked. */
export function checkRenderedSkill(text, surface, exposure = "all") {
  const problems = [];
  const counts = { invocations: 0, tools: 0, fields: 0 };
  const report = (line, snippet, problem) => {
    if (problem) problems.push({ line, snippet, problem });
  };
  for (const inv of textInvocations(text)) {
    counts.invocations++;
    report(inv.line, inv.snippet, check(inv.argv, surface.commands, surface.pro));
  }
  const refs = skillReferences(text);
  for (const ref of refs.tools) {
    counts.tools++;
    report(ref.line, ref.snippet, checkTool(ref, surface, exposure));
  }
  for (const ref of refs.fields) {
    counts.fields++;
    report(ref.line, ref.snippet, checkFieldRef(ref, surface));
  }
  return { problems, counts };
}

/** Stand-ins for a template no host ships yet, so it is checked before one does. */
const UNLISTED_HOSTS = [
  { id: "(unlisted, cli)", dialect: "cli", frontmatter: {} },
  { id: "(unlisted, mcp)", dialect: "mcp", exposure: "all", frontmatter: {} },
];

/**
 * Render every host's skills, and every template no host lists, and check
 * them. Returns `{ problems: string[], counts }`; a template that does not
 * render is a problem, not a throw.
 */
export function checkSkills({ hostsPath, workflowsDir, surface }) {
  const { hosts } = loadHosts(hostsPath);
  const templates = readdirSync(workflowsDir).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md")).sort();
  const listed = new Set(Object.values(hosts).flatMap((h) => h.skills));
  const jobs = [];
  for (const [id, host] of Object.entries(hosts)) for (const skill of host.skills) jobs.push({ host: { id, ...host }, skill });
  for (const skill of templates.filter((t) => !listed.has(t))) for (const host of UNLISTED_HOSTS) jobs.push({ host, skill });

  const problems = [];
  const counts = { skills: 0, invocations: 0, tools: 0, fields: 0 };
  for (const { host, skill } of jobs) {
    const where = `${host.id}/${skill}`;
    let text;
    try {
      text = renderSkill(readFileSync(join(workflowsDir, `${skill}.md`), "utf8"), host);
    } catch (err) {
      problems.push(`${where}  does not render: ${err.message}`);
      continue;
    }
    counts.skills++;
    const exposure = host.dialect === "mcp" ? host.exposure : "all";
    const result = checkRenderedSkill(text, surface, exposure);
    for (const k of ["invocations", "tools", "fields"]) counts[k] += result.counts[k];
    for (const p of result.problems) problems.push(`${where}:${p.line}  ${p.problem}\n    ${p.snippet}`);
  }
  return { problems, counts };
}
