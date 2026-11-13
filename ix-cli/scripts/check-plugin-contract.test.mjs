// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { check, checkField, checkMcp, definedHelpers, fieldReads, jsonInvocations, mcpReferences, textInvocations } from "./check-plugin-contract.mjs";

const surface = new Map([
  ["map", { flags: new Set(["--remap", "--silent"]), subcommands: new Set() }],
]);

describe("plugin prompt invocations", () => {
  it("recognizes escaped Markdown delimiters in raw TypeScript template strings", () => {
    const source = 'const prompt = `Instructions:\nRun \\`ix map --remap\\` before continuing.`;';
    const [invocation] = textInvocations(source);
    expect(invocation.argv).toEqual(["map", "--remap"]);
    expect(invocation.line).toBe(2);
    expect(check(invocation.argv, surface)).toBeNull();
  });

  it("still reports unknown flags inside escaped delimiters", () => {
    const [invocation] = textInvocations('const prompt = `Run \\`ix map --missing\\`.`;');
    expect(check(invocation.argv, surface)).toBe('"map" has no --missing');
  });

  it("recognizes escaped fenced commands in template prompts", () => {
    const fence = "\\`\\`\\`";
    const invocations = textInvocations(`Instructions:\r\n${fence}sh\r\nix map --remap\r\nix map --missing\r\n${fence}`);
    expect(invocations.map(inv => inv.argv)).toEqual([["map", "--remap"], ["map", "--missing"]]);
    expect(invocations.map(inv => inv.line)).toEqual([3, 4]);
    expect(check(invocations[0].argv, surface)).toBeNull();
    expect(check(invocations[1].argv, surface)).toBe('"map" has no --missing');
  });

  it("keeps ordinary Markdown spans and fenced commands", () => {
    const invocations = textInvocations("Run `ix map --remap`.\n```sh\nix map --silent\n```");
    expect(invocations.map(inv => inv.argv)).toEqual([["map", "--remap"], ["map", "--silent"]]);
    expect(invocations.map(inv => inv.line)).toEqual([1, 3]);
    expect(invocations.every(inv => check(inv.argv, surface) === null)).toBe(true);
  });

  it("checks trailing punctuation in escaped fenced prompts without hiding misspelt flags", () => {
    const fence = "\\`\\`\\`";
    const invocations = textInvocations(`${fence}sh\nix map --remap.\nix map --remapp.\n${fence}`);
    expect(invocations.map(inv => inv.line)).toEqual([2, 3]);
    expect(invocations.map(inv => check(inv.argv, surface))).toEqual([null, '"map" has no --remapp']);
  });

  it("preserves JSON prompt decoding, paths and line numbers", () => {
    const invocations = jsonInvocations(JSON.stringify({ agent: { prompt: "Instructions:\n`ix map --remap`" } }));
    expect(invocations).toMatchObject([{ argv: ["map", "--remap"], line: "agent.prompt:2" }]);
    expect(check(invocations[0].argv, surface)).toBeNull();
  });
});

// ── What plugins read from the output (#994) ────────────────────────────────
//
// The fixtures below are shaped like the plugin code and skill text the issue
// quotes; the plugin repositories themselves are not in this checkout.

const commands = new Set(["locate", "status", "text", "map"]);
const published = new Map([
  ["locate", ["resolvedTarget", "resolvedTarget.name", "resolvedTarget.kind", "resolvedTarget.path", "lineRange", "lineRange.start", "candidates", "candidates[]", "candidates[].name"]],
  ["text", ["[]", "[].path", "[].line_start", "[].snippet"]],
]);
// Stands in for acceptsField from the build (tested in json-fields.test.ts):
// undefined for a command with no published list.
const fields = {
  accepts: (command, path) => published.get(command)?.includes(path),
  mcp: { tools: new Set(["ix_impact", "ix_explain", "ix_locate", "ix_map"]), jsonResults: new Set(["ix_map"]) },
};

function problems(text, file) {
  return fieldReads(text, file, commands)
    .map((read) => checkField(read.command, read.path, fields))
    .filter(Boolean);
}

describe("field reads in plugin code", () => {
  it("fails a jq read of a field locate does not emit (mismatch 1, shell hook)", () => {
    const sh = [
      "ix_locate_json() {",
      '  local out conf',
      '  out=$(ix locate "$1" --format json 2>/dev/null) || return 1',
      "  conf=$(printf '%s' \"$out\" | jq -r '.confidence // 0')",
      "  name=$(jq -r '.resolvedTarget.name' <<<\"$out\")",
      "}",
    ].join("\n");
    expect(fieldReads(sh, "hooks/ix-lib.sh", commands)).toMatchObject([
      { command: "locate", path: "confidence", line: 4 },
      { command: "locate", path: "resolvedTarget.name", line: 5 },
    ]);
    expect(problems(sh, "hooks/ix-lib.sh")).toEqual(['"ix locate --format json" has no field "confidence"']);
  });

  it("fails a property read of a field locate does not emit (mismatch 1, TypeScript hook)", () => {
    const ts = [
      'const raw = await runIx(["locate", symbol, "--format", "json"]);',
      "const parsed = JSON.parse(raw.stdout);",
      'if (typeof parsed.confidence === "number" && parsed.confidence < 0.6) return;',
      "const where = parsed.resolvedTarget?.path ?? parsed.lineRange.start;",
      "if (raw.exitCode !== 0) return;",
    ].join("\n");
    expect(problems(ts, "mcp/hooks/pre-search.ts")).toEqual([
      '"ix locate --format json" has no field "confidence"',
      '"ix locate --format json" has no field "confidence"',
    ]);
  });

  it("reads Python dict lookups and destructuring, and accepts emitted fields", () => {
    const py = [
      'data = run_ix_json(["locate", sym])',
      'first = data["candidates"][0]["name"]',
      'if data.get("confidence", 0) < 0.5:',
      "    return",
    ].join("\n");
    expect(fieldReads(py, "hooks/lookup.py", commands).map((r) => r.path)).toEqual(["candidates[].name", "confidence"]);
    expect(problems(py, "hooks/lookup.py")).toEqual(['"ix locate --format json" has no field "confidence"']);
    const ts = 'const { resolvedTarget, confidence: c } = JSON.parse(await runIx(["locate", s]));';
    expect(problems(ts, "a.ts")).toEqual(['"ix locate --format json" has no field "confidence"']);
  });

  it("does not carry a variable into a function whose parameter has its name", () => {
    const ts = [
      'const parsed = JSON.parse(await runIx(["locate", s]));',
      "if (parsed.resolvedTarget) {",
      "  use(parsed.lineRange);",
      "}",
      "function gate(parsed: Other) { return parsed.confidence; }",
      "const later = (parsed) => parsed.score;",
      "async check(parsed) {",
      "  return parsed.whatever;",
      "}",
    ].join("\n");
    expect(fieldReads(ts, "a.ts", commands).map((r) => r.path)).toEqual(["resolvedTarget", "lineRange"]);
    const py = ['data = run_ix_json(["locate", s])', "def other(data):", '    return data["confidence"]'].join("\n");
    expect(fieldReads(py, "a.py", commands)).toEqual([]);
  });

  it("ends a parameter's or loop variable's shadow where its function or loop ends", () => {
    const ts = [
      'const out = JSON.parse(await runIx(["locate", s, "--format", "json"]));',
      "for (const out of rows) { use(out.score); }",
      "items.forEach(function (out) { return out.x; });",
      "out.confidence;",
      "items.map((out) => out.y);",
      "try { go(); } catch (out) { log(out.message); }",
      "for (const { out } of pairs) use(out.z);",
      "out.lineRange;",
    ].join("\n");
    expect(fieldReads(ts, "a.ts", commands).map((r) => [r.path, r.line])).toEqual([["confidence", 4], ["lineRange", 8]]);
    // An assignment inside the shadowing function is to its parameter.
    const inner = [
      'const out = JSON.parse(await runIx(["locate", s]));',
      "function f(out) { out = load(); return out.other; }",
      "out.candidates;",
    ].join("\n");
    expect(fieldReads(inner, "a.ts", commands).map((r) => r.path)).toEqual(["candidates"]);
  });

  it("follows Python scope: def bodies and comprehensions end, a for statement rebinds", () => {
    const py = [
      'data = run_ix_json(["locate", s])',
      "def f(",
      "        data,",
      "):",
      '    return data["x"]',
      'print(data["confidence"])',
      'names = [data.get("n") for data in rows]',
      'print(data["candidates"])',
      "for data in rows:",
      '    data["confidence"]',
      'data["lineRange"]',
    ].join("\n");
    expect(fieldReads(py, "a.py", commands).map((r) => [r.path, r.line])).toEqual([["confidence", 6], ["candidates", 8]]);
    const withAs = ['data = run_ix_json(["locate", s])', "with open(p) as data:", '    data["confidence"]'].join("\n");
    expect(fieldReads(withAs, "a.py", commands)).toEqual([]);
  });

  it("leaves reads it cannot tie to a published command alone", () => {
    const sh = [
      "st=$(ix status --format json)",
      "jq -r '.graphCompleted' <<<\"$st\"",
      "cfg=$(cat config.json)",
      "jq -r '.whatever' <<<\"$cfg\"",
      "ix locate X --format llm | grep risk",
    ].join("\n");
    expect(problems(sh, "a.sh")).toEqual([]);
    // Tied to `ix status` (same line), which has no published list yet.
    expect(fieldReads("st=$(ix status --format json); jq -r '.graphCompleted' <<<\"$st\"", "a.sh", commands))
      .toMatchObject([{ command: "status", path: "graphCompleted", line: 1 }]);
  });

  it("follows a jq pipe only as far as the context is a plain path", () => {
    expect(fieldReads("ix text foo --format json | jq '.[] | .path, .line_start'", "a.sh", commands).map((r) => r.path))
      .toEqual(["[]", "[].path", "[].line_start"]);
    expect(fieldReads("ix text foo --format json | jq '.[0].snippet'", "a.sh", commands).map((r) => r.path))
      .toEqual(["[].snippet"]);
    // Inside map()/select() the dot is an element, not the root: not attributed.
    expect(fieldReads("ix locate X --format json | jq '.candidates | map(.bogus)'", "a.sh", commands).map((r) => r.path))
      .toEqual(["candidates"]);
  });

  it("does not check a command with no published list", () => {
    expect(checkField("status", "graphCompleted", fields)).toBeNull();
    expect(checkField("locate", "lineRange.start", fields)).toBeNull();
    expect(checkField("locate", "confidence", fields)).toBe('"ix locate --format json" has no field "confidence"');
  });
});

describe("MCP tool and result names in skill text", () => {
  const skill = [
    "## Impact",
    "",
    "Call `ix_impact` with the symbol. Check `ok` first, then read `risk_level`",
    "and `traversal.nodes_visited`.",
    "",
    "`ix_explain` returns `facts.calleeCount`; plans are in `data.plans`.",
    "",
    "`ix_map` returns JSON: read `files.total`. Use `ix_query` for anything else.",
    "Call `ix_locate` on `IxClient.search` or `src/config.ts`.",
  ].join("\n");

  it("fails a JSON path read from a tool that returns records (mismatch 2)", () => {
    const found = mcpReferences(skill).map((ref) => checkMcp(ref, fields.mcp)).filter(Boolean);
    expect(found).toEqual([
      '"ix_impact" returns `--format llm` records, not JSON: it has no field "traversal.nodes_visited"',
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "facts.calleeCount"',
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "data.plans"',
      'unknown MCP tool "ix_query"',
    ]);
  });

  it("reports line numbers and ignores symbols and file names", () => {
    const refs = mcpReferences(skill);
    expect(refs.find((r) => r.path === "facts.calleeCount")).toMatchObject({ tool: "ix_explain", line: 6 });
    expect(refs.some((r) => r.path === "IxClient.search" || r.path === "src/config.ts")).toBe(false);
  });

  it("hands the section back to the CLI at an `ix …` command span", () => {
    const text = "Call `ix_impact` first. Or run `ix impact X --format json` and read `summary.directDependents`.";
    expect(mcpReferences(text).map((ref) => checkMcp(ref, fields.mcp)).filter(Boolean)).toEqual([]);
  });

  it("does not take a word ending in ix for a wrapper", () => {
    expect(fieldReads("x=$(prefix_text foo)\njq '.bogus' <<<\"$x\"", "a.sh", commands)).toEqual([]);
    expect(fieldReads("x=$(ix_text_json foo)\njq '.[0].path' <<<\"$x\"", "a.sh", commands))
      .toMatchObject([{ command: "text", path: "[].path" }]);
  });

  it("does not take the plugin's own ix_ helpers for MCP tools", () => {
    const helpers = new Set([
      ...definedHelpers("ix_lib() {\n  :\n}\nfunction ix_run { :; }\n", "hooks/common.sh"),
      ...definedHelpers("def ix_fetch(x):\n    pass\n", "ix_tools/client.py"),
    ]);
    expect([...helpers].sort()).toEqual(["ix_fetch", "ix_lib", "ix_run", "ix_tools"]);
    const text = "The hook defines `ix_locate_json`, `ix_lib`, `ix_run`, `ix_fetch` and `ix_tools`. `ix_query` is not a tool.";
    expect(mcpReferences(text).map((ref) => checkMcp(ref, fields.mcp, helpers)).filter(Boolean))
      .toEqual(['unknown MCP tool "ix_query"']);
    // Without the plugin's definitions only the json wrapper form is known.
    expect(mcpReferences(text).map((ref) => checkMcp(ref, fields.mcp)).filter(Boolean)).toEqual([
      'unknown MCP tool "ix_lib"', 'unknown MCP tool "ix_run"', 'unknown MCP tool "ix_fetch"',
      'unknown MCP tool "ix_tools"', 'unknown MCP tool "ix_query"',
    ]);
  });

  it("takes the MCP tools a plugin serves itself for its own, names and fields both", () => {
    const code = [
      'server.tool("ix_query", schema, run);',
      'export const tools = [{ name: "ix_status", handler }];',
      "const TABLE = { ix_docs_tool: { run } };",
      "api.registerTool('ix_neighbors', spec);",
      '@mcp.tool(name="ix_ask")',
      "def ask(q): ...",
      "const ix_impact = makeTool(impactSpec);",
    ].join("\n");
    const served = definedHelpers(code, "mcp/server.ts");
    expect([...served].sort()).toEqual(["ix_ask", "ix_docs_tool", "ix_impact", "ix_neighbors", "ix_query", "ix_status"]);
    const text = [
      "Use `ix_query` and read `results.items`; `ix_status` gives `graph.ready`.",
      "`ix_neighbors` returns `callers.count`. `ix_impact` has `traversal.nodes_visited`.",
      "`ix_explain` gives `facts.calleeCount`.",
    ].join("\n");
    // The plugin's ix_impact is its own tool, not ix mcp's, whatever it returns.
    expect(mcpReferences(text).map((ref) => checkMcp(ref, fields.mcp, served)).filter(Boolean)).toEqual([
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "facts.calleeCount"',
    ]);
  });

  it("takes on/for/with as an argument only right after the tool", () => {
    const text = [
      "After `ix_impact`, check for `traversal.nodes_visited` and `facts.calleeCount`.",
      "Sort `ix_impact` results with `summary.risk`.",
      "Run `ix_impact` on `auth.verify`, `api.get` and `db.connect`; `ix_explain` for `client.query`.",
    ].join("\n");
    expect(mcpReferences(text).filter((ref) => ref.path).map((ref) => [ref.tool, ref.path])).toEqual([
      ["ix_impact", "traversal.nodes_visited"],
      ["ix_impact", "facts.calleeCount"],
      ["ix_impact", "summary.risk"],
    ]);
  });

  it("does not take a qualified symbol name given as an argument, or a host name, for a read", () => {
    const text = [
      "## Callers",
      "Use `ix_locate` on `auth.verify_token`, `api.get` or `client.query`. Docs: `docs.example.com`.",
      "Pass a symbol like `pkg.mod.fn` to `ix_explain`, e.g. `db.connect`.",
      "Then read `traversal.nodes_visited` and `.facts.calleeCount`, or `data.plans`.",
    ].join("\n");
    expect(mcpReferences(text).map((ref) => checkMcp(ref, fields.mcp)).filter(Boolean)).toEqual([
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "traversal.nodes_visited"',
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "facts.calleeCount"',
      '"ix_explain" returns `--format llm` records, not JSON: it has no field "data.plans"',
    ]);
  });

  it("reads tool references from JSON prompt strings too", () => {
    const json = JSON.stringify({ prompt: "Use `ix_impact` and read `data.risk`." });
    expect(mcpReferences(json, ".json").map((ref) => checkMcp(ref, fields.mcp)).filter(Boolean))
      .toEqual(['"ix_impact" returns `--format llm` records, not JSON: it has no field "data.risk"']);
  });
});
