// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// Graph reads refuse a directory no workspace covers (workspace_not_mapped),
// and this suite runs from a checkout that is not registered anywhere. It is
// about resolution, not scoping, so the directory counts as mapped here.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));


const search = vi.hoisted(() => vi.fn());

vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(...args: unknown[]) { return search(...args); }
  },
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    readStitchScope: () => undefined,
    writeStitchScope: vi.fn(),
  };
});

type Register = (program: Command) => void;
type LoadRegister = () => Promise<Register>;

const UNRESOLVED_COMMANDS: ReadonlyArray<readonly [string, readonly string[], LoadRegister]> = [
  ["context", ["context", "DefinitelyMissing"], async () => (await import("../commands/context.js")).registerContextCommand],
  ["explain", ["explain", "DefinitelyMissing"], async () => (await import("../commands/explain.js")).registerExplainCommand],
  ["read", ["read", "DefinitelyMissing"], async () => (await import("../commands/read.js")).registerReadCommand],
  ["overview", ["overview", "DefinitelyMissing"], async () => (await import("../commands/overview.js")).registerOverviewCommand],
  ["impact", ["impact", "DefinitelyMissing"], async () => (await import("../commands/impact.js")).registerImpactCommand],
  ["contains", ["contains", "DefinitelyMissing"], async () => (await import("../commands/contains.js")).registerContainsCommand],
  ["callers", ["callers", "DefinitelyMissing"], async () => (await import("../commands/callers.js")).registerCallersCommand],
  ["callees", ["callees", "DefinitelyMissing"], async () => (await import("../commands/callers.js")).registerCallersCommand],
  ["imports", ["imports", "DefinitelyMissing"], async () => (await import("../commands/imports.js")).registerImportsCommand],
  ["imported-by", ["imported-by", "DefinitelyMissing"], async () => (await import("../commands/imports.js")).registerImportsCommand],
  ["depends", ["depends", "DefinitelyMissing"], async () => (await import("../commands/depends.js")).registerDependsCommand],
  ["trace", ["trace", "DefinitelyMissing"], async () => (await import("../commands/trace.js")).registerTraceCommand],
  ["history", ["history", "DefinitelyMissing"], async () => (await import("../commands/history.js")).registerHistoryCommand],
  ["diff", ["diff", "3", "5", "DefinitelyMissing"], async () => (await import("../commands/diff.js")).registerDiffCommand],
];

async function run(register: Register, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const program = new Command();
  program.name("ix").exitOverride();
  register(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => stdout.push(parts.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  const write = vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => {
    stderr.push(String(part).replace(/\n$/, ""));
    return true;
  }) as never);
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("unresolved targets in machine formats", () => {
  let savedExitCode: number | string | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    search.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it.each(UNRESOLVED_COMMANDS)("returns JSON and a non-zero status from ix %s", async (_command, args, loadRegister) => {
    const result = await run(await loadRegister(), [...args, "--format", "json"]);

    expect(process.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "unresolved_target",
      message: 'No entity found matching "DefinitelyMissing".',
      ...(["explain", "impact", "callers"].includes(_command) ? { didYouMean: [] } : {}),
    });
  });

  it.each(UNRESOLVED_COMMANDS)("returns LLM output and a non-zero status from ix %s", async (_command, args, loadRegister) => {
    const result = await run(await loadRegister(), [...args, "--format", "llm"]);

    expect(process.exitCode).toBe(3);
    expect(result.stdout).toBe(
      'error code=unresolved_target message="No entity found matching \\"DefinitelyMissing\\"."',
    );
  });

  it.each(UNRESOLVED_COMMANDS)("keeps text stdout clean and exits non-zero from ix %s", async (_command, args, loadRegister) => {
    const result = await run(await loadRegister(), [...args, "--format", "text"]);

    expect(process.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('No entity found matching "DefinitelyMissing".');
  });

  it("reports ambiguous targets with candidates without claiming they are missing", async () => {
    search.mockResolvedValue([
      { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
      { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
    ]);

    const result = await run(
      (await import("../commands/overview.js")).registerOverviewCommand,
      ["overview", "Duplicate", "--format", "json"],
    );

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: "ambiguous_target",
      message: 'Ambiguous symbol "Duplicate".',
      candidates: [
        { id: "first-id", name: "Duplicate" },
        { id: "second-id", name: "Duplicate" },
      ],
    });
  });

  // `ix read`'s ambiguity is the one exception (docs/llm-format.md): it has
  // always exited 0 with an `ambiguous` record, and plugins that drop stdout
  // on a non-zero exit would lose the candidates. Its miss still exits 3.
  it("keeps ix read's ambiguity at exit 0 with its own ambiguous record", async () => {
    search.mockResolvedValue([
      { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
      { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
    ]);
    const register = (await import("../commands/read.js")).registerReadCommand;

    const json = await run(register, ["read", "Duplicate", "--format", "json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body).toMatchObject({ targetType: "ambiguous-symbol" });
    expect(body.error).toBeUndefined();
    expect(body.candidates).toHaveLength(2);

    process.exitCode = undefined;
    const llm = await run(register, ["read", "Duplicate", "--format", "llm"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(llm.stdout).toMatch(/^ambiguous kind=symbol target=Duplicate /);
  });

  it("keeps an out-of-range pick classified as ambiguity and exits non-zero", async () => {
    search.mockResolvedValue([
      { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
      { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
    ]);

    const result = await run(
      (await import("../commands/overview.js")).registerOverviewCommand,
      ["overview", "Duplicate", "--pick", "3", "--format", "json"],
    );

    expect(process.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.error).toBe("ambiguous_target");
    expect(output.diagnostics[0]).toEqual({
      code: "pick_out_of_range",
      message: "--pick 3 is out of range (1-2).",
    });
  });

  it("reports both missing trace endpoints in one result", async () => {
    const result = await run(
      (await import("../commands/trace.js")).registerTraceCommand,
      ["trace", "MissingFrom", "--to", "MissingTo", "--format", "json"],
    );

    expect(process.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "unresolved_target",
      message: 'No entities found matching "MissingFrom" or "MissingTo".',
      targets: ["MissingFrom", "MissingTo"],
    });
  });

  // locate joins the same contract (#539) and keeps its own body, with the
  // shared `{error, message}` fields added rather than substituted:
  // shipped plugins read `diagnostics` off it, and the point of #539 is that
  // the exit code becomes informative without the payload going away.
  it("returns a non-zero status from ix locate while keeping its result body", async () => {
    const { registerLocateCommand } = await import("../commands/locate.js");
    const result = await run(registerLocateCommand, ["locate", "DefinitelyMissing", "--format", "json"]);

    expect(process.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      resolvedTarget: null,
      resolutionMode: "none",
      systemPath: null,
      diagnostics: ["No graph entity found."],
      // The slug and message every other command's miss carries.
      error: "unresolved_target",
      message: 'No graph entity found for "DefinitelyMissing".',
      didYouMean: [],
    });
  });

  it("exits non-zero for an AMBIGUOUS locate, in every format (#547)", async () => {
    // The one command that used to disagree. This exited 0 in the first draft
    // of #539, reasoned as "several candidates is an answer, not a miss" --
    // #547 settled the opposite for the eight graph commands, and locate
    // reporting the same condition with a different status is worse than
    // either rule on its own. It is also the contradiction #539 opens with:
    // the llm branch already prints `error code=ambiguous_target`, so exiting
    // 0 told a machine caller the command succeeded while handing it an error.
    const { registerLocateCommand } = await import("../commands/locate.js");
    search.mockResolvedValue([
      { id: "first-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/first.ts" } },
      { id: "second-id", kind: "function", name: "Duplicate", provenance: { sourceUri: "src/second.ts" } },
    ]);

    for (const format of ["json", "llm", "text"] as const) {
      process.exitCode = undefined;
      const result = await run(registerLocateCommand, ["locate", "Duplicate", "--format", format]);
      expect(process.exitCode, `format=${format}`).toBe(2);
      // ...and the body still says what it always said. The exit code becomes
      // informative without the payload going away, which is #539's whole point.
      if (format === "json") expect(JSON.parse(result.stdout).resolutionMode).toBe("ambiguous");
      // N-of-M (CL-19B): locate's own json body carries the same total.
      if (format === "json") expect(JSON.parse(result.stdout).total).toBe(2);
      if (format === "llm") expect(result.stdout).toContain("ambiguous_target");
    }
  });

  it("emits an llm error record and a non-zero status from ix locate", async () => {
    const { registerLocateCommand } = await import("../commands/locate.js");
    const result = await run(registerLocateCommand, ["locate", "DefinitelyMissing", "--format", "llm"]);

    expect(process.exitCode).toBe(3);
    // This record was already being emitted -- while exiting 0, which is the
    // contradiction #539 opens with.
    expect(result.stdout).toContain("unresolved_target");
  });
});
