// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

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

const node = (id: string, name: string, kind: string, uri: string) => ({
  id, name, kind, provenance: { sourceUri: uri },
});

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { registerOverviewCommand } = await import("../commands/overview.js");
  const program = new Command();
  program.name("ix").exitOverride();
  registerOverviewCommand(program);
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

describe("an ambiguous target in llm format", () => {
  let savedExitCode: number | string | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    search.mockReset().mockResolvedValue([
      node("1111aaaa-0000-0000-0000-000000000000", "Duplicate", "function", "src/first.ts"),
      node("2222bbbb-0000-0000-0000-000000000000", "Duplicate", "function", "src/second.ts"),
    ]);
  });

  afterEach(() => { process.exitCode = savedExitCode; });

  it("names each candidate well enough to pick one", async () => {
    const { stdout } = await run(["overview", "Duplicate", "--format", "llm"]);
    const lines = stdout.split("\n");

    // Previously the whole answer was
    // `candidates=1:Duplicate,2:Duplicate` — three entries differing in nothing.
    expect(lines[0]).toContain("error code=ambiguous_target");
    expect(lines[0]).toContain("count=2");
    expect(lines[1]).toBe("candidate n=1 name=Duplicate kind=function path=src/first.ts id=1111aaaa");
    expect(lines[2]).toBe("candidate n=2 name=Duplicate kind=function path=src/second.ts id=2222bbbb");
    expect(lines[3]).toContain("hint");
    expect(lines[3]).toContain("--pick <n>");
  });

  it("carries the full id in json, where size is not the constraint", async () => {
    const { stdout } = await run(["overview", "Duplicate", "--format", "json"]);
    expect(JSON.parse(stdout).candidates[0].id).toBe("1111aaaa-0000-0000-0000-000000000000");
  });

  it("drops the flags it was already given from the hint", async () => {
    // Called directly: which flags are worth suggesting is the reporter's
    // decision, and reaching it through a command means first arranging for
    // the resolver not to break the tie.
    const { reportAmbiguousTarget } = await import("../ui.js");
    const candidates = [
      { id: "1111aaaa-0000-0000-0000-000000000000", name: "Duplicate", kind: "function", path: "src/first.ts" },
      { id: "2222bbbb-0000-0000-0000-000000000000", name: "Duplicate", kind: "function", path: "src/second.ts" },
    ];
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => lines.push(parts.join(" ")));
    try {
      reportAmbiguousTarget("Duplicate", { resolutionMode: "ambiguous", candidates }, "llm", { kind: "function", path: "src" });
    } finally {
      log.mockRestore();
    }
    const hint = lines.join("\n").split("\n").find((line) => line.startsWith("hint"))!;
    expect(hint).toContain("--pick <n>");
    expect(hint).not.toContain("--kind");
    expect(hint).not.toContain("--path");
  });
});

describe("a target that resolves to nothing", () => {
  let savedExitCode: number | string | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    search.mockReset();
  });

  afterEach(() => { process.exitCode = savedExitCode; });

  /** The name exists — `--path` is what excluded it. */
  const elsewhere = () => {
    search.mockResolvedValue([
      node("5555eeee-0000-0000-0000-000000000000", "Widget", "class", "src/ui/widget.ts"),
      node("6666ffff-0000-0000-0000-000000000000", "Widget", "function", "src/ui/factory.ts"),
    ]);
  };

  it("says where the symbol does live, in llm", async () => {
    elsewhere();
    const { stdout } = await run(["overview", "Widget", "--path", "server", "--format", "llm"]);
    const lines = stdout.split("\n");

    expect(lines[0]).toContain("error code=unresolved_target");
    expect(lines[1]).toBe("suggestion n=1 name=Widget kind=class path=src/ui/widget.ts id=5555eeee");
    expect(lines[2]).toBe("suggestion n=2 name=Widget kind=function path=src/ui/factory.ts id=6666ffff");
    expect(lines[3]).toContain("hint");
  });

  it("says it in json too", async () => {
    elsewhere();
    const { stdout } = await run(["overview", "Widget", "--path", "server", "--format", "json"]);
    const payload = JSON.parse(stdout);
    expect(payload.error).toBe("unresolved_target");
    expect(payload.suggestions).toHaveLength(2);
    expect(payload.suggestions[0]).toMatchObject({ name: "Widget", kind: "class", path: "src/ui/widget.ts" });
  });

  it("says the miss once, not once per stream", async () => {
    elsewhere();
    // An agent runs `ix ... 2>&1`. The record on stdout is the answer; the
    // prose on stderr was a second copy of it.
    const { stdout, stderr } = await run(["overview", "Widget", "--path", "server", "--format", "llm"]);
    expect(stdout).toContain("unresolved_target");
    expect(stderr).not.toContain("No entity named");
  });

  it("still tells a person, in text", async () => {
    elsewhere();
    const { stdout, stderr } = await run(["overview", "Widget", "--path", "server"]);
    expect(stdout).toBe("");
    expect(stderr).toContain('No entity named "Widget" found in paths matching "server".');
    expect(stderr).toContain("Did you mean:");
    expect(stderr).toContain("src/ui/widget.ts");
  });

  it("adds nothing when the name matched nothing at all", async () => {
    // A miss here means the search came back empty, so there is nothing to
    // suggest — and re-running it without `nameOnly` returns the same empty
    // set, which is why nothing tries.
    search.mockResolvedValue([]);
    const { stdout } = await run(["overview", "NothingLikeThis", "--format", "json"]);
    expect(JSON.parse(stdout)).toEqual({
      error: "unresolved_target",
      message: 'No entity found matching "NothingLikeThis".',
    });
    expect(search).toHaveBeenCalledTimes(1);
  });
});
