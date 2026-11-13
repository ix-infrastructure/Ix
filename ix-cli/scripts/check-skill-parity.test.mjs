// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as pro from "../src/cli/register/pro-surface.ts";
import * as oss from "../src/cli/register/oss.ts";
import * as server from "../src/mcp/server.ts";
import {
  UNSNAPSHOTTED_FIELDS,
  checkFieldRef,
  checkSkills,
  loadSkillSurface,
  readSnapshots,
  recordedFields,
  skillReferences,
} from "./check-skill-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const repoRoot = join(cliRoot, "..");
const snapshotDir = join(cliRoot, "src", "cli", "__tests__", "__snapshots__");

let surface;
beforeAll(async () => {
  surface = await loadSkillSurface({ oss, server, pro, Command, snapshots: readSnapshots(snapshotDir) });
});

describe("the seeded workflow skills", () => {
  it("name only commands, flags, tools and fields this CLI has", () => {
    const { problems, counts } = checkSkills({
      hostsPath: join(repoRoot, "skills", "hosts.json"),
      workflowsDir: join(repoRoot, "skills", "workflows"),
      surface,
    });
    expect(problems).toEqual([]);
    // It checked something of each kind, not nothing.
    expect(counts.skills).toBeGreaterThan(1);
    expect(counts.invocations).toBeGreaterThan(0);
    expect(counts.tools).toBeGreaterThan(0);
    expect(counts.fields).toBeGreaterThan(0);
  });
});

describe("a template naming what the CLI does not have", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-parity-"));
    mkdirSync(join(dir, "workflows"));
    writeFileSync(
      join(dir, "hosts.json"),
      JSON.stringify({
        hosts: {
          shell: { dialect: "cli", skills: ["bad"] },
          tools: { dialect: "mcp", exposure: "all", skills: ["bad"] },
          narrow: { dialect: "mcp", exposure: "core", skills: ["core-only"] },
        },
      }),
    );
    writeFileSync(
      join(dir, "workflows", "bad.md"),
      [
        "---",
        "name: bad",
        "---",
        "",
        "{{calls}}",
        "ix callers symbol=$ARGUMENTS limit=5 no_such_flag=1",
        "{{/calls}}",
        "",
        "{{#if mcp}}",
        "Then call `ix_no_such_tool`.",
        "{{/if}}",
        "Read `no_such_field=` on the `impact` record and the `no_such_record` record.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "workflows", "core-only.md"),
      "---\nname: core-only\n---\n\nUse `ix_callers` here.\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails, naming the missing flag, tool, argument and field", () => {
    const { problems } = checkSkills({ hostsPath: join(dir, "hosts.json"), workflowsDir: join(dir, "workflows"), surface });
    const text = problems.join("\n");
    // the flag, in the cli rendering
    expect(text).toContain('shell/bad:6  "callers" has no --no-such-flag');
    // the tool argument, in the mcp rendering
    expect(text).toContain('tools/bad:5  "ix_callers" has no argument "no_such_flag"');
    // the tool
    expect(text).toContain('tools/bad:7  unknown MCP tool "ix_no_such_tool"');
    // the field and the record, in both renderings
    for (const host of ["shell", "tools"]) {
      expect(text).toContain(`${host}/bad:`);
      expect(text).toMatch(new RegExp(`${host}/bad:\\d+  the "impact" record has no field "no_such_field"`));
      expect(text).toMatch(new RegExp(`${host}/bad:\\d+  no recorded output has a "no_such_record" record`));
    }
    // a real tool the host's --tools set does not serve
    expect(text).toContain('narrow/core-only:5  "ix_callers" is not served under `ix mcp --tools=core`');
    // and nothing else
    expect(problems).toHaveLength(8);
  });

  it("checks a template no host lists yet, in both dialects", () => {
    writeFileSync(join(dir, "workflows", "unlisted.md"), "Run `ix callers X --bogus`.\n");
    try {
      const { problems } = checkSkills({ hostsPath: join(dir, "hosts.json"), workflowsDir: join(dir, "workflows"), surface });
      expect(problems.filter((p) => p.includes("/unlisted:"))).toEqual([
        '(unlisted, cli)/unlisted:1  "callers" has no --bogus\n    ix callers X --bogus',
        '(unlisted, mcp)/unlisted:1  "callers" has no --bogus\n    ix callers X --bogus',
      ]);
    } finally {
      rmSync(join(dir, "workflows", "unlisted.md"));
    }
  });

  it("reports a template that does not render instead of throwing", () => {
    writeFileSync(join(dir, "workflows", "broken.md"), "{{nope}}\n");
    try {
      const { problems } = checkSkills({ hostsPath: join(dir, "hosts.json"), workflowsDir: join(dir, "workflows"), surface });
      expect(problems.filter((p) => p.includes("/broken"))).toEqual([
        '(unlisted, cli)/broken  does not render: unknown directive "{{nope}}"',
        '(unlisted, mcp)/broken  does not render: unknown directive "{{nope}}"',
      ]);
    } finally {
      rmSync(join(dir, "workflows", "broken.md"));
    }
  });
});

describe("field references", () => {
  it("ties a field to the record the text names", () => {
    const { fields } = skillReferences(
      "Read `nodes=` on the `depends` record.\n" +
        "If the `edges` record has `callees` > 20 AND `callers` < 2:\n" +
        "Use `risk=` on the `impact` record and the `counts` record (`dependents=`).\n" +
        "From the `behavior text=` records.\n",
    );
    expect(fields.map(({ record, field, line }) => [line, record, field])).toEqual([
      [1, "depends", null],
      [1, "depends", "nodes"],
      [2, "edges", null],
      [2, "edges", "callees"],
      [2, "edges", "callers"],
      [3, "impact", null],
      [3, "counts", null],
      [3, "impact", "risk"],
      [3, null, "dependents"],
      [4, "behavior", "text"],
    ]);
  });

  it("reads llm records from snapshot text, quoted values and escapes included", () => {
    const snap = [
      "exports[`x 1`] = `",
      '"impact target=paint risk=low summary="Low \\\\"risk\\\\" a=b"',
      'behavior text="Limited"',
      'counts callers=0 message="last""',
      "  [32mparseConfig[39m",
      '"',
      "`;",
    ].join("\n");
    const records = recordedFields([snap]);
    expect([...records.keys()]).toEqual(["impact", "behavior", "counts"]);
    // `a=b` is inside the quoted summary, not a field.
    expect([...records.get("impact")]).toEqual(["target", "risk", "summary"]);
    expect([...records.get("behavior")]).toEqual(["text"]);
    expect([...records.get("counts")]).toEqual(["callers", "message"]);
  });

  it("checks against the recorded snapshots", () => {
    expect(checkFieldRef({ record: "impact", field: "risk" }, surface)).toBeNull();
    expect(checkFieldRef({ record: "counts", field: "callers" }, surface)).toBeNull();
    expect(checkFieldRef({ record: null, field: "dependents_total" }, surface)).toBeNull();
    expect(checkFieldRef({ record: "impact", field: "callers" }, surface)).toBe('the "impact" record has no field "callers"');
  });

  // The hand-kept list stands in for snapshots that do not exist yet. Hold
  // it to the source that prints each record, so it cannot outlive a rename.
  it("keeps the hand-kept fields to what the source prints", () => {
    for (const [record, { source, fields }] of Object.entries(UNSNAPSHOTTED_FIELDS)) {
      const text = readFileSync(join(cliRoot, source), "utf8");
      expect(text, `${source} prints a "${record}" record`).toContain(`llmLine("${record}", [`);
      for (const field of fields) expect(text, `${source}: ${record} ${field}=`).toContain(`["${field}", `);
    }
  });
});
