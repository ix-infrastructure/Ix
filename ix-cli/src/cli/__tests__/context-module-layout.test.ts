// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// `ix context` used to be one 3,500-line file holding every job it does (#928),
// so any change to the command touched the same file and ranking or rendering
// could not be reviewed apart from option parsing and file storage. These
// checks keep the split: the command file registers and dispatches, and the
// jobs live in src/cli/context/ in functions a reviewer can read whole.

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND = join(CLI, "commands", "context.ts");
const MODULES = readdirSync(join(CLI, "context"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(CLI, "context", f));

const MAX_COMMAND_LINES = 400;
const MAX_FUNCTION_LINES = 100;

function longFunctions(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (end - start + 1 > MAX_FUNCTION_LINES) {
        found.push(`${relative(CLI, file)}:${start} (${end - start + 1} lines)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("ix context module layout", () => {
  it("keeps commands/context.ts to registration and dispatch", () => {
    const lines = readFileSync(COMMAND, "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(MAX_COMMAND_LINES);
  });

  it("has the jobs in src/cli/context/", () => {
    const names = MODULES.map((f) => relative(join(CLI, "context"), f));
    for (const job of ["options.ts", "investigations.ts", "issue.ts", "bundle.ts", "rank.ts", "render.ts", "next.ts"]) {
      expect(names).toContain(job);
    }
  });

  it(`has no function longer than ${MAX_FUNCTION_LINES} lines`, () => {
    expect([COMMAND, ...MODULES].flatMap(longFunctions)).toEqual([]);
  });
});
