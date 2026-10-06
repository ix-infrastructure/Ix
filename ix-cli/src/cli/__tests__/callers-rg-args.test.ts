// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callersTextSearchArgs } from "../commands/callers.js";

const hasRg = spawnSync("rg", ["--version"]).status === 0;

/**
 * `ix callers` falls back to rg with the target's name. A name is whatever the
 * graph or the caller says, so it must reach rg as a literal pattern: a name
 * shaped like an option used to be parsed as one (`--pre=cat` made rg wait on
 * a preprocessor until killed, `-mt-4` became flags).
 */
describe.skipIf(!hasRg)("ix callers text fallback passes the name to rg as a literal", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ix-callers-rg-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "a.ts"),
      ["call(--pre=cat);", "x = a-mt-4;", "operator()", "const $scope = 1;", "--files"].join("\n") + "\n",
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function search(name: string): { status: number | null; lines: string[] } {
    const r = spawnSync("rg", callersTextSearchArgs(name, root), { encoding: "utf-8", timeout: 10_000 });
    const lines = (r.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "match")
      .map((e) => String(e.data.lines.text).trim());
    return { status: r.status, lines };
  }

  it.each([
    ["--pre=cat", "call(--pre=cat);"],
    ["-mt-4", "x = a-mt-4;"],
    ["operator()", "operator()"],
    ["$scope", "const $scope = 1;"],
    ["--files", "--files"],
  ])("finds %s as text", (name, line) => {
    const r = search(name);
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([line]);
  });
});
