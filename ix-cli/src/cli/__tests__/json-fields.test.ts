// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTextCommand } from "../commands/text.js";
import { acceptsField, JSON_FIELDS } from "../contracts/fields.js";
import { emitErrorRecord } from "../errors.js";
import { formatTextResults, sliceRanked, type TextResult } from "../format.js";
import { fieldPaths } from "./helpers/field-paths.js";

// The published field lists (contracts/fields.ts) against what the commands
// print. The lists are what scripts/check-plugin-contract.mjs checks plugin
// reads against, so a printed path missing here would fail a plugin that reads
// it correctly. json-contracts.test.ts runs the same check on every locate and
// read case it pins.

const hasRipgrep = spawnSync("rg", ["--version"]).status === 0;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function unpublished(command: string, body: unknown): string[] {
  return fieldPaths(body).filter((p) => acceptsField(command, p) !== true);
}

describe("ix text --format json", () => {
  // The plugin runners parse this output as one array: no paging envelope, no
  // object at the root. That is now a test, not a comment in format.ts.
  const full: TextResult = {
    path: "src/a.ts", line_start: 3, line_end: 3, snippet: "needle()", engine: "ripgrep", score: 1,
    language: "typescript", symbol_hint: "run",
  };

  it("prints a bare array whose every path is published, paged or not", () => {
    for (const slice of [sliceRanked([full, full], 1), sliceRanked([full], 20), sliceRanked([full, full], 1, undefined, 1)]) {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      formatTextResults(slice, "json", { windowFull: true });
      const body = JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"));
      log.mockRestore();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(slice.rows.length);
      expect(unpublished("text", body)).toEqual([]);
    }
    expect(fieldPaths([full]).sort()).toEqual(JSON_FIELDS.text.filter((p) => p.startsWith("[]")).sort());
  });

  it.skipIf(!hasRipgrep)("the real command prints the same shape", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ix-json-fields-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.ts"), "export function run() {\n  return needle();\n}\n");
    writeFileSync(path.join(root, "notes.md"), "a needle in prose\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerTextCommand(program);
    await program.parseAsync(["text", "needle", "--root", root, "--format", "json"], { from: "user" });
    const body = JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(unpublished("text", body)).toEqual([]);
  });
});

describe("the failure record (contracts/envelope.ts)", () => {
  it("every path emitErrorRecord prints is published for every listed command", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emitErrorRecord("workspace_not_mapped", "not mapped", "run ix map", [["dir", "/w"]], "json");
    const body = JSON.parse(log.mock.calls.map((call) => call.join(" ")).join("\n"));
    log.mockRestore();
    expect(fieldPaths(body).sort()).toEqual(["dir", "error", "message", "next"]);
    for (const command of Object.keys(JSON_FIELDS)) expect(unpublished(command, body)).toEqual([]);
  });
});

describe("acceptsField", () => {
  it("accepts listed paths, open records and nothing else", () => {
    expect(acceptsField("locate", "resolvedTarget.name")).toBe(true);
    expect(acceptsField("locate", "candidates[].name")).toBe(true);
    expect(acceptsField("locate", "graph.status")).toBe(true);
    expect(acceptsField("locate", "confidence")).toBe(false);
    expect(acceptsField("locate", "graphs.status")).toBe(false);
    expect(acceptsField("text", "[].path")).toBe(true);
    expect(acceptsField("text", "results")).toBe(false);
    expect(acceptsField("text", "error")).toBe(true);
    expect(acceptsField("locate", "next")).toBe(true);
    expect(acceptsField("locate", "summary")).toBe(true);
    expect(acceptsField("locate", "summary.notFound")).toBe(true);
    expect(acceptsField("locate", "targets[].resolvedTarget.path")).toBe(true);
    expect(acceptsField("locate", "targets[].exitCode")).toBe(true);
    expect(acceptsField("locate", "targets[].confidence")).toBe(false);
  });

  it("knows nothing about a command with no published list", () => {
    expect(acceptsField("status", "graphCompleted")).toBeUndefined();
    expect(acceptsField("toString", "x")).toBeUndefined();
  });
});
