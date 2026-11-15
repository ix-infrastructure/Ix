// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { ENV_VARS } from "../src/cli/env.ts";
import {
  collectProblems,
  NOT_VARIABLES,
  readDoc,
  regenerate,
  renderEnvTable,
  scanSource,
} from "./check-env-registry.mjs";

const uses = scanSource();
const doc = readDoc();

describe("environment-variable registry (#948)", () => {
  // This is the gate: it runs in `npm run test:unit`, so code that reads an
  // unregistered IX_* name, or a registry change without the docs, fails CI.
  it("every IX_* name in ix-cli/src is registered, and the docs table matches", () => {
    expect(collectProblems({ registry: ENV_VARS, uses, doc })).toEqual([]);
  });

  it("names an unregistered variable and where it is used", () => {
    const withNew = new Map(uses).set("IX_SOMETHING_NEW", ["src/cli/x.ts:3"]);
    const problems = collectProblems({ registry: ENV_VARS, uses: withNew, doc });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^IX_SOMETHING_NEW is used in src\/cli\/x\.ts:3 but is not registered/);
  });

  it("flags a registered variable nothing mentions any more", () => {
    const registry = {
      ...ENV_VARS,
      IX_GONE: { type: "flag", default: false, visibility: "internal", description: "gone" },
    };
    expect(collectProblems({ registry, uses, doc })).toEqual([
      "IX_GONE is registered in src/cli/env.ts but nothing in ix-cli/src outside it mentions it: remove it.",
    ]);
  });

  // env.ts names every entry, so if it were scanned no entry could ever be
  // reported stale. A registered variable whose only reader went away must be.
  it("does not count the registry's own mention of a variable as a use", () => {
    expect([...uses.values()].flat().some((where) => where.startsWith("src/cli/env.ts:"))).toBe(false);
    const readerGone = new Map(uses);
    readerGone.delete("IX_MCP_HINT_TOOLS");
    expect(collectProblems({ registry: ENV_VARS, uses: readerGone, doc })).toEqual([
      "IX_MCP_HINT_TOOLS is registered in src/cli/env.ts but nothing in ix-cli/src outside it mentions it: remove it.",
    ]);
  });

  it("flags a docs table that drifted from the registry, and --write fixes it", () => {
    const edited = doc.replace("| `IX_DEBUG` |", "| `IX_DEBUGGING` |");
    expect(edited).not.toBe(doc);
    expect(collectProblems({ registry: ENV_VARS, uses, doc: edited })).toEqual([
      expect.stringMatching(/table in .* is out of date/),
    ]);
    expect(regenerate(edited, ENV_VARS)).toBe(doc);
  });

  it("lists every public variable and no internal one", () => {
    const table = renderEnvTable(ENV_VARS);
    for (const [name, spec] of Object.entries(ENV_VARS)) {
      expect(table.includes(`| \`${name}\` |`), name).toBe(spec.visibility === "public");
    }
  });

  it("keeps NOT_VARIABLES to names that still appear in the source", () => {
    for (const name of Object.keys(NOT_VARIABLES)) expect(uses.has(name), name).toBe(true);
  });
});
