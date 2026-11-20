// Copyright 2026 Ix Infrastructure Inc.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createIxMcpServer, IX_MCP_CORE_TOOL_NAMES, IX_MCP_PRO_TOOL_NAMES } from "../src/mcp/server.ts";
import { CORE_TOOLS, PRO_TOOLS, cliArgv, loadHosts, renderAll, renderSkill } from "./render-skills.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const workflowsDir = join(repoRoot, "skills", "workflows");
const hostsPath = join(repoRoot, "skills", "hosts.json");
// `.expected`, not `.md`: check-links scans every tracked .md, and the claude
// skill links to a file only its plugin has. Regenerate with
// `node scripts/render-skills.mjs --out <tmp>` and copy each SKILL.md over.
const expectedDir = join(here, "..", "test", "fixtures", "render-skills");

const CLI = { dialect: "cli", skills: [], frontmatter: {} };
const MCP = { dialect: "mcp", exposure: "all", skills: [], frontmatter: {} };
const render = (source, host = CLI, id = "h") => renderSkill(source, { id, ...host });

describe("template syntax", () => {
  it("renders an inline call as a command line or as a tool call", () => {
    const src = "Run {{ix callers symbol=$ARGUMENTS limit=15}} now.";
    expect(render(src)).toBe("Run `ix callers $ARGUMENTS --limit 15 --format llm` now.");
    expect(render(src, MCP)).toBe('Run `ix_callers` with `{ "symbol": "$ARGUMENTS", "limit": 15 }` now.');
  });

  it("names a command without arguments in either dialect", () => {
    expect(render("the {{ix imported-by}} result")).toBe("the `ix imported-by` result");
    expect(render("the {{ix imported-by}} result", MCP)).toBe("the `ix_imported_by` result");
  });

  it("quotes values that would not survive the shell or JSON bare", () => {
    expect(render('{{ix search term="two words" kind=class}}')).toBe('`ix search "two words" --kind class --format llm`');
    expect(render('{{ix search term="two words" kind=class}}', MCP)).toBe('`ix_search` with `{ "term": "two words", "kind": "class" }`');
  });

  it("turns a multi-word parameter into a hyphenated flag", () => {
    expect(render("{{ix trace symbol=X max_depth=3}}")).toBe("`ix trace X --max-depth 3 --format llm`");
  });

  it("renders a calls block as a bash fence or a bullet list", () => {
    const src = "Run in parallel:\n{{calls}}\nix impact target=$ARGUMENTS\nix explain symbol=$ARGUMENTS\n{{/calls}}\nDone.\n";
    expect(render(src)).toBe(
      "Run in parallel:\n```bash\nix impact $ARGUMENTS --format llm\nix explain $ARGUMENTS --format llm\n```\nDone.\n",
    );
    expect(render(src, MCP)).toBe(
      'Run in parallel:\n- `ix_impact` with `{ "target": "$ARGUMENTS" }`\n- `ix_explain` with `{ "symbol": "$ARGUMENTS" }`\nDone.\n',
    );
  });

  it("keeps a block conditional's lines only for its dialect or host, and drops the tag lines", () => {
    const src = "a\n{{#if cli}}\nshell\n{{/if}}\n{{#if mcp}}\ntools\n{{/if}}\n{{#if host=claude}}\nclaude only\n{{/if}}\nz\n";
    expect(render(src)).toBe("a\nshell\nz\n");
    expect(render(src, MCP)).toBe("a\ntools\nz\n");
    expect(render(src, CLI, "claude")).toBe("a\nshell\nclaude only\nz\n");
  });

  it("supports a conditional inside a line", () => {
    const src = "Write it{{#if host=claude}} using the Write tool{{/if}}.\nnext\n";
    expect(render(src, CLI, "claude")).toBe("Write it using the Write tool.\nnext\n");
    expect(render(src, MCP, "cursor")).toBe("Write it.\nnext\n");
  });

  it("puts the host's preamble where the template asks, or nothing", () => {
    const src = "---\nname: x\n---\n\n{{preamble}}\nbody\n";
    expect(render(src)).toBe("---\nname: x\n---\n\nbody\n");
    expect(render(src, { ...CLI, preamble: "> [shared](../shared.md)" })).toBe("---\nname: x\n---\n\n> [shared](../shared.md)\n\nbody\n");
  });

  it("merges host front matter into the template's, in order, and removes keys set to null", () => {
    const src = "---\nname: x\ndescription: d — with: colon\nargument-hint: <a> [--b]\n---\n\nbody\n";
    expect(render(src)).toBe(src);
    const host = { ...CLI, frontmatter: { description: "host description", "argument-hint": null, model: "sonnet" } };
    expect(render(src, host)).toBe("---\nname: x\ndescription: host description\nmodel: sonnet\n---\n\nbody\n");
  });

  it("rejects what it does not understand instead of shipping it", () => {
    expect(() => render("{{ix}}")).toThrow(/command/);
    expect(() => render("{{ix impact $ARGUMENTS}}")).toThrow(/name=value/);
    expect(() => render("{{ix impact target=X target=Y}}")).toThrow(/twice/);
    expect(() => render("{{bogus}}")).toThrow(/unknown directive/);
    expect(() => render("{{#if cli}}\nopen\n")).toThrow(/unclosed/);
    expect(() => render("{{#if wsl}}x{{/if}}")).toThrow(/condition/);
    expect(() => render("{{calls}}\n\n{{/calls}}\n")).toThrow(/empty/);
    expect(() => render("x", { ...CLI, dialect: "rpc" })).toThrow(/dialect/);
  });

  it("gives the argv a CLI call runs", () => {
    expect(cliArgv({ command: "depends", args: [["symbol", "X"], ["depth", 2]] })).toEqual(["depends", "X", "--depth", "2", "--format", "llm"]);
  });
});

describe("mcp exposure", () => {
  const CORE = { ...MCP, exposure: "core" };

  it("refuses a call to a tool a core host does not register", () => {
    expect(render("{{ix impact target=X}} and {{ix neighbors}}", CORE)).toBe('`ix_impact` with `{ "target": "X" }` and `ix_neighbors`');
    expect(() => render("{{ix explain symbol=X}}", CORE, "cursor")).toThrow(/cursor.*tools=core.*ix_explain/);
    expect(() => render("the {{ix explain}} result", CORE)).toThrow(/ix_explain/);
    expect(() => render("{{calls}}\nix callers symbol=X\n{{/calls}}\n", CORE)).toThrow(/ix_callers/);
    // A cli host runs shell commands, so the MCP tool set does not apply.
    expect(render("{{ix explain symbol=X}}", { ...CLI, exposure: "core" })).toBe("`ix explain X --format llm`");
  });

  it("knows the same core set `ix mcp --tools=core` advertises", () => {
    expect([...CORE_TOOLS].sort()).toEqual([...IX_MCP_CORE_TOOL_NAMES].sort());
    expect([...PRO_TOOLS].sort()).toEqual([...IX_MCP_PRO_TOOL_NAMES].sort());
  });

  it("would refuse to render ix-impact for a host on the core set", () => {
    const source = readFileSync(join(workflowsDir, "ix-impact.md"), "utf8");
    expect(() => renderSkill(source, { id: "cursor", ...CORE })).toThrow(/tools=core/);
  });
});

describe("hosts.json", () => {
  it("rejects an unknown host key, dialect, exposure or skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "ix-render-hosts-"));
    try {
      const write = (hosts) => {
        const p = join(dir, "hosts.json");
        writeJson(p, { hosts });
        return p;
      };
      expect(() => loadHosts(write({ a: { dialect: "cli", skills: [], frontmatter: {}, colour: "red" } }))).toThrow(/colour/);
      expect(() => loadHosts(write({ a: { dialect: "sh", skills: [] } }))).toThrow(/dialect/);
      expect(() => loadHosts(write({ a: { dialect: "mcp", exposure: "most", skills: [] } }))).toThrow(/exposure/);
      expect(() => loadHosts(write({ a: { dialect: "mcp", skills: [] } }))).toThrow(/exposure/);
      expect(() => loadHosts(write({ a: { dialect: "cli", skills: [], preamble: ["x"] } }))).toThrow(/preamble/);
      expect(() => renderAll({ hostsPath: write({ a: { dialect: "cli", skills: ["nope"] } }), workflowsDir, outDir: join(dir, "out") }))
        .toThrow(/nope/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rendered workflow skills", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("match the expected CLI (claude) and MCP (cursor) output for ix-impact", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ix-render-skills-"));
    dirs.push(outDir);
    const written = renderAll({ hostsPath, workflowsDir, outDir });
    expect(written.map((p) => p.slice(outDir.length + 1).split("\\").join("/")).sort()).toEqual([
      "claude/skills/ix-impact/SKILL.md",
      "cursor/skills/ix-impact/SKILL.md",
    ]);
    for (const host of ["claude", "cursor"]) {
      const rel = join(host, "skills", "ix-impact", "SKILL.md");
      expect(readFileSync(join(outDir, rel), "utf8"), rel).toBe(readFileSync(join(expectedDir, `${rel}.expected`), "utf8"));
    }
  });

  it("render only the host asked for", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ix-render-skills-"));
    dirs.push(outDir);
    renderAll({ hostsPath, workflowsDir, outDir, only: "cursor" });
    expect(readdirSync(outDir)).toEqual(["cursor"]);
    expect(() => renderAll({ hostsPath, workflowsDir, outDir, only: "nobody" })).toThrow(/nobody/);
  });

  it("use field names the CLI prints, not ones it does not", () => {
    for (const host of ["claude", "cursor"]) {
      const text = readFileSync(join(expectedDir, host, "skills", "ix-impact", "SKILL.md.expected"), "utf8");
      expect(text).toContain("risk=");
      for (const invented of ["risk_level", "fan_out", "fan_in", "at_risk_behavior", "calleeCount", "nodes_visited"]) {
        expect(text, `${host}: ${invented}`).not.toContain(invented);
      }
    }
  });

  // Changes the Claude plugin made after the copy this template started from
  // (ix-claude-plugin #42, #53, and Ix-pro#108 folding `ix bugs` into `ix bug list`).
  it("keep the Claude plugin's current text where it moved on", () => {
    const text = readFileSync(join(expectedDir, "claude", "skills", "ix-impact", "SKILL.md.expected"), "utf8");
    expect(text).toMatch(/^---\n[\s\S]*\ndisable-model-invocation: true\n---\n/);
    expect(text).toContain("Do not run `ix briefing`");
    expect(text).toContain("ix bug list --format text");
    expect(text).not.toContain("ix briefing --format json");
    expect(text).not.toContain("ix bugs ");
  });

  // The two dialects must be the same call. For every call an mcp host's
  // skills make, the tool must be advertised under the host's exposure, and
  // `ix mcp` must turn its arguments into exactly the argv the cli dialect
  // renders for the same call (flag spelling aside: --k v vs --k=v).
  it("make MCP calls `ix mcp` advertises and runs as the same CLI command", async () => {
    const { hosts } = loadHosts(hostsPath);
    let checked = 0;
    for (const [id, host] of Object.entries(hosts)) {
      if (host.dialect !== "mcp") continue;
      const calls = [];
      for (const skill of host.skills) {
        renderSkill(readFileSync(join(workflowsDir, `${skill}.md`), "utf8"), { id, ...host }, { onCall: (c) => calls.push(c) });
      }
      const ran = [];
      const server = createIxMcpServer({
        version: "test",
        tools: host.exposure,
        runIx: async (args) => {
          ran.push(args);
          return { ok: true, stdout: "ok", stderr: "" };
        },
      });
      const client = new Client({ name: "render-skills-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const advertised = new Set((await client.listTools()).tools.map((t) => t.name));
        for (const call of calls.filter((c) => c.args.length > 0)) {
          const tool = `ix_${call.command.replace(/-/g, "_")}`;
          expect(advertised.has(tool), `${id}: ${tool} under --tools=${host.exposure}`).toBe(true);
          ran.length = 0;
          const result = await client.callTool({ name: tool, arguments: Object.fromEntries(call.args) });
          expect(result.isError, `${id}: ${tool}`).toBeFalsy();
          expect(normalize(ran[0]), `${id}: ${tool}`).toEqual(normalize(cliArgv(call)));
          checked++;
        }
      } finally {
        await client.close();
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/** argv as {command, positionals, flags}, so `--k v`, `--k=v` and `-- pos` compare equal. */
function normalize(argv) {
  const [command, ...rest] = argv;
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = rest[++i];
    } else positionals.push(a);
  }
  return { command, positionals, flags };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}
