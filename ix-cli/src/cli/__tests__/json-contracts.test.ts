// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerCallersCommand } from "../commands/callers.js";
import { registerLocateCommand } from "../commands/locate.js";
import { registerReadCommand } from "../commands/read.js";
import type { AmbiguousTargetJson, TextMatchesJson, UnresolvedTargetJson } from "../contracts/miss.js";
import type { LocateJson, LocateMissJson, LocateStrictAmbiguityJson, LocateTextMatchesJson } from "../contracts/locate.js";
import type { ReadAmbiguityJson, ReadFailureJson, ReadJson } from "../contracts/read.js";
import type { MultiTargetJson, TargetSummaryJson } from "../contracts/envelope.js";
import { acceptsField } from "../contracts/fields.js";
import { fieldPaths } from "./helpers/field-paths.js";

// Golden shapes for `--format json` (contracts/). Each case runs the real
// command action against a mocked backend and pins the exact keys it prints.
// The key lists are typed against the contract, so a key renamed in the type
// fails typecheck here, and a key renamed or dropped in the output fails the
// run. Fields may be added (output-formats.md, "JSON compatibility"): add the
// new key to the type and to the list below in the same change.

vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));

const { search } = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
    async expand() { return { nodes: [], edges: [] }; }
    async resolvePrefix() { return []; }
    async entity(id: string) {
      return { node: { id, kind: "function", name: "Unique", attrs: { line_start: 3, line_end: 9 }, provenance: { sourceUri: "src/only.ts" } } };
    }
    async provenance(id: string) { return { entityId: id, chain: [] }; }
    async listByKind() { return []; }
  },
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  getEffectiveSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

// A name the graph lacks but a source file mentions answers with that file.
vi.mock("../miss-reason.js", () => ({
  missProbeWouldRun: () => true,
  explainSymbolMiss: async (_client: unknown, symbol: string) => symbol === "ConfigKey"
    ? { reason: "symbol_not_extracted", message: "in source text only", matches: [{ path: "src/settings.ts", line: 4, snippet: "ConfigKey = 1" }] }
    : null,
}));

const DUPLICATES = [
  { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
  { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
];
const UNIQUE = [{ id: "only-id", kind: "function", name: "Unique", provenance: { sourceUri: "src/only.ts" } }];

async function json(args: string[]): Promise<{ body: Record<string, unknown>; exitCode: number }> {
  const program = new Command().name("ix").exitOverride();
  registerLocateCommand(program);
  registerReadCommand(program);
  registerCallersCommand(program);
  const stdout: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => { stdout.push(parts.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  process.exitCode = undefined;
  try {
    await program.parseAsync([...args, "--format", "json"], { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  const body = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
  // Every printed path is in the published list (contracts/fields.ts) that
  // the plugin-contract check reads, for the commands that have one.
  const command = args[0];
  expect(fieldPaths(body).filter((p) => acceptsField(command, p) === false)).toEqual([]);
  return { body, exitCode: Number(process.exitCode ?? 0) };
}

/** The printed keys, sorted, against the golden list (also sorted). */
function expectKeys<T>(body: Record<string, unknown>, keys: Array<keyof T & string>): void {
  expect(Object.keys(body).sort()).toEqual([...keys].sort());
}

let savedExitCode: typeof process.exitCode;
let workspace: string;

beforeAll(() => {
  // A tiny workspace for `ix read`: one unique file, one basename in two places.
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ix-json-contracts-"));
  fs.mkdirSync(path.join(workspace, "a"));
  fs.mkdirSync(path.join(workspace, "b"));
  fs.writeFileSync(path.join(workspace, "only.ts"), "export const one = 1;\nexport const two = 2;\n");
  fs.writeFileSync(path.join(workspace, "a", "dup.ts"), "a\n");
  fs.writeFileSync(path.join(workspace, "b", "dup.ts"), "b\n");
});
afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  savedExitCode = process.exitCode;
  search.mockReset().mockImplementation(async (term: string) => ({ Duplicate: DUPLICATES, Unique: UNIQUE, Uniq: UNIQUE } as Record<string, unknown[]>)[term] ?? []);
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("shared miss envelope (contracts/miss.ts)", () => {
  it("unresolved_target: callers' miss", async () => {
    const { body, exitCode } = await json(["callers", "Missing", "--no-suggest"]);
    expect(exitCode).toBe(3);
    expect(body).toMatchObject({ error: "unresolved_target", message: 'No entity found matching "Missing".' });
    expectKeys<UnresolvedTargetJson>(body, ["error", "message", "didYouMean"]);
  });

  it("ambiguous_target: callers --strict", async () => {
    const { body, exitCode } = await json(["callers", "Duplicate", "--strict"]);
    expect(exitCode).toBe(2);
    expect(body.error).toBe("ambiguous_target");
    expectKeys<AmbiguousTargetJson>(body, ["error", "message", "candidates", "total", "diagnostics"]);
  });
});

describe("ix locate (contracts/locate.ts)", () => {
  it("an answer", async () => {
    const { body, exitCode } = await json(["locate", "Unique"]);
    expect(exitCode).toBe(0);
    expectKeys<LocateJson>(body, ["resolvedTarget", "lineRange", "systemPath", "hasMapData", "diagnostics"]);
    expect(Object.keys(body.resolvedTarget as object).sort()).toEqual(["id", "kind", "name", "path"]);
  });

  it("an ambiguous name answers its top candidate with resolutionNotices (the default)", async () => {
    const { body, exitCode } = await json(["locate", "Duplicate"]);
    expect(exitCode).toBe(0);
    expect(body.error).toBeUndefined();
    expectKeys<LocateJson>(body, ["resolvedTarget", "resolutionMode", "lineRange", "systemPath", "hasMapData", "diagnostics", "resolutionNotices"]);
    const [notice] = body.resolutionNotices as Array<Record<string, unknown>>;
    expect(Object.keys(notice).sort()).toEqual(["candidates", "chosen", "code", "message", "target", "total"]);
    expect(notice.code).toBe("ambiguous_target");
  });

  it("a fuzzy match answers with resolutionMode fuzzy and resolutionNotices", async () => {
    const { body, exitCode } = await json(["locate", "Uniq"]);
    expect(exitCode).toBe(0);
    expect(body.resolutionMode).toBe("fuzzy");
    expectKeys<LocateJson>(body, ["resolvedTarget", "resolutionMode", "lineRange", "systemPath", "hasMapData", "diagnostics", "resolutionNotices"]);
    expect((body.resolutionNotices as Array<{ code: string }>).map((n) => n.code)).toEqual(["fuzzy_match"]);
  });

  it("a miss: locate's body plus the shared envelope", async () => {
    const { body, exitCode } = await json(["locate", "Missing", "--no-suggest"]);
    expect(exitCode).toBe(3);
    expect(body.error).toBe("unresolved_target");
    expectKeys<LocateMissJson>(body, ["resolvedTarget", "resolutionMode", "systemPath", "diagnostics", "error", "message", "didYouMean"]);
  });

  it("an ambiguity under --strict keeps its slug in `code` (a listed exception)", async () => {
    const { body, exitCode } = await json(["locate", "Duplicate", "--strict"]);
    expect(exitCode).toBe(2);
    expect(body.code).toBe("ambiguous_target");
    expectKeys<LocateStrictAmbiguityJson>(body, [
      "code", "message", "resolvedTarget", "resolutionMode", "candidates", "total", "systemPath", "diagnostics",
    ]);
  });

  it("a name only source text mentions", async () => {
    const { body, exitCode } = await json(["locate", "ConfigKey"]);
    expect(exitCode).toBe(0);
    expect(body.note).toBe("text_matches");
    expectKeys<LocateTextMatchesJson>(body, [
      "resolvedTarget", "resolutionMode", "systemPath", "diagnostics",
      "note", "target", "reason", "message", "textMatches", "shown", "total",
    ] satisfies Array<keyof TextMatchesJson | "resolvedTarget" | "resolutionMode" | "systemPath" | "diagnostics">);
  });

  it("several targets: the grouping (contracts/envelope.ts), a thrown target's failure record included", async () => {
    search.mockImplementation(async (term: string) => {
      if (term === "Boom") throw new Error("backend exploded");
      return ({ Unique: UNIQUE } as Record<string, unknown[]>)[term] ?? [];
    });
    // json() fails on any printed path the published list lacks.
    const { body } = await json(["locate", "Unique", "Missing", "Boom", "--no-suggest"]);
    expectKeys<MultiTargetJson<unknown>>(body, ["targets", "summary"]);
    const groups = body.targets as Array<Record<string, unknown>>;
    expect(groups.map((g) => g.target)).toEqual(["Unique", "Missing", "Boom"]);
    expect(groups[2]).toMatchObject({ error: "cli_error" });
    expect(Object.keys(body.summary as object).sort()).toEqual(
      (["total", "ok", "ambiguous", "notFound", "notMapped", "failed"] satisfies Array<keyof TargetSummaryJson>).sort(),
    );
  });
});

describe("ix read (contracts/read.ts)", () => {
  it("a file", async () => {
    const { body, exitCode } = await json(["read", "only.ts", "--root", workspace]);
    expect(exitCode).toBe(0);
    expect(body).toMatchObject({ targetType: "file", path: expect.stringContaining("only.ts"), lineStart: 1 });
    expectKeys<ReadJson>(body, ["targetType", "path", "lineStart", "lineEnd", "content"]);
  });

  it("an ambiguous file name exits 0 with no `error` (a listed exception)", async () => {
    const { body, exitCode } = await json(["read", "dup.ts", "--root", workspace]);
    expect(exitCode).toBe(0);
    expect(body.targetType).toBe("ambiguous-file");
    expect(body.error).toBeUndefined();
    expectKeys<ReadAmbiguityJson>(body, ["targetType", "candidates", "diagnostics"]);
  });

  it("an ambiguous symbol name exits 0 with no `error` (a listed exception)", async () => {
    const { body, exitCode } = await json(["read", "Duplicate", "--root", workspace]);
    expect(exitCode).toBe(0);
    expect(body.targetType).toBe("ambiguous-symbol");
    expectKeys<ReadAmbiguityJson>(body, ["targetType", "candidates", "diagnostics"]);
  });

  it("a fuzzy symbol answers with resolutionMode fuzzy and resolutionNotices", async () => {
    // The mocked entity lives at src/only.ts; it exists only for this case so
    // `read only.ts` above stays a unique file name.
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "only.ts"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    let result: Awaited<ReturnType<typeof json>>;
    try {
      result = await json(["read", "Uniq", "--root", workspace]);
    } finally {
      fs.rmSync(path.join(workspace, "src"), { recursive: true, force: true });
    }
    const { body, exitCode } = result;
    expect(exitCode).toBe(0);
    expect(body.resolutionMode).toBe("fuzzy");
    expect((body.resolutionNotices as Array<{ code: string }>).map((n) => n.code)).toEqual(["fuzzy_match"]);
    expectKeys<ReadJson>(body, ["targetType", "path", "lineStart", "lineEnd", "content", "symbol", "kind", "resolutionMode", "resolutionNotices"]);
  });

  it("a miss is the shared unresolved_target record", async () => {
    const { body, exitCode } = await json(["read", "Missing", "--root", workspace]);
    expect(exitCode).toBe(3);
    expect(body.error).toBe("unresolved_target");
    expectKeys<UnresolvedTargetJson>(body, ["error", "message"]);
  });

  it("a refused read is the plain failure envelope", async () => {
    const { body, exitCode } = await json(["read", "only.ts:5-2", "--root", workspace]);
    expect(exitCode).toBe(1);
    expect(body.error).toBe("invalid_line_range");
    expectKeys<ReadFailureJson>(body, ["error", "message"]);
  });
});
