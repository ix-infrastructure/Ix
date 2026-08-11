import { describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerOssCommands, registerProStubs } from "../register/oss.js";

/**
 * CLAUDE.md tells agents to detect a Pro-gated install by the exact string
 * `The '<name>' command requires Ix Pro.` and then stop retrying. That contract
 * is only worth documenting if the message actually reaches the user for the
 * invocations people really type — which are never the bare command.
 */
function runStub(argv: string[]): { out: string; err: string; exitCode: number | string | undefined } {
  const program = new Command();
  program.name("ix").exitOverride();
  registerProStubs(program);

  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  process.exitCode = undefined;

  let code: number | string | undefined;
  try {
    program.parse(["node", "ix", ...argv]);
    // commander's error path (exitOverride) throws, so the message lands in the
    // catch below rather than here.
  } catch (e) {
    err.push(String((e as Error).message));
  } finally {
    code = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { out: out.join("\n"), err: err.join("\n"), exitCode: code };
}

describe("Pro stubs", () => {
  it("reports Pro for the bare command", () => {
    const { err, exitCode } = runStub(["bug"]);
    expect(err).toContain("The 'bug' command requires Ix Pro.");
    expect(exitCode).toBe(1);
  });

  // The regression: commander rejects excess operands before the action runs,
  // so every documented Pro example used to die with "too many arguments"
  // instead of the sentinel the docs tell agents to look for.
  it.each([
    ["bug", ["bug", "create", "a title", "--affects", "Entity"]],
    ["bug", ["bug", "update", "abc123", "--status", "resolved"]],
    ["bug", ["bug", "show", "abc123", "--format", "json"]],
    ["truth", ["truth", "add", "Support 100k file repos"]],
    ["truth", ["truth", "list", "--format", "json"]],
    ["goal", ["goal", "create", "Support GitHub", "--format", "json"]],
    ["goals", ["goals", "--status", "active", "--format", "json"]],
    ["decide", ["decide", "Use X", "--rationale", "because", "--affects", "Entity"]],
    ["briefing", ["briefing", "--format", "json"]],
    ["decisions", ["decisions", "--topic", "ingestion", "--limit", "10"]],
    ["plan", ["plan", "task", "title", "--plan", "p1", "--resolves", "b1"]],
    ["task", ["task", "show", "t1"]],
    ["workflow", ["workflow", "attach", "w1"]],
  ])("reports Pro for %s with arguments", (name, argv) => {
    const { err, exitCode } = runStub(argv);
    expect(err).toContain(`The '${name}' command requires Ix Pro.`);
    expect(err).not.toContain("too many arguments");
    expect(exitCode).toBe(1);
  });

  // `patches` is NOT Pro. ix-cli implements it (commands/patches.ts), but it
  // sat in PRO_COMMANDS while never being registered, so the stub answered
  // "requires Ix Pro" for a command this repo ships — #371. Pinning its absence
  // here is what stops it being re-added to the list: a stub for a command that
  // exists in OSS shadows the real implementation, and because
  // registerOssCommands runs first the symptom is silent rather than a crash.
  it("does not stub patches — ix-cli owns it", () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerProStubs(program);
    expect(program.commands.map(c => c.name())).not.toContain("patches");
  });

  // The other half, and the one that actually delivers #371. Absence from the
  // stub list only helps if `oss.ts` registers the real command — drop the
  // registerPatchesCommand(program) call and the test above still passes while
  // `ix patches` becomes commander's "unknown command", which is where #371
  // started. Both halves have to be pinned or either can silently regress.
  it("registers patches as an OSS command", () => {
    const program = new Command();
    program.name("ix").exitOverride();
    registerOssCommands(program);

    const patches = program.commands.find(c => c.name() === "patches");
    expect(patches).toBeDefined();
    // --format llm is why the OSS implementation is the one worth keeping when
    // commander drops @ix/pro's duplicate registration on a Kartr install.
    expect(patches?.options.map(o => o.long)).toContain("--format");
  });

  // @ix/pro registers a plural list command alongside `plan` and `task`
  // (register.ts: registerPlansCommand, registerTasksCommand). Stubbing only the
  // singular is the failure this pins: the plural fell through to commander's
  // "unknown command" instead of the sentinel above, so an agent told to stop on
  // `requires Ix Pro.` saw an unrecognized error and had nothing to match.
  //
  // `goals` is NOT in that category and is only still stubbed by oversight:
  // Ix-pro#103 deleted the command, #327 correctly dropped the stub, and #384
  // re-added it on the stated premise that Pro registers a plural for *every*
  // singular — which was already false. Do not use this row as evidence that
  // `ix goals` exists; removing it is a pending follow-up.
  it.each([
    ["plan", "plans"],
    ["task", "tasks"],
    ["goal", "goals"],
  ])("stubs both %s and %s", (singular, plural) => {
    for (const name of [singular, plural]) {
      expect(runStub([name]).err).toContain(`The '${name}' command requires Ix Pro.`);
    }
  });

  // `bugs` is deliberately absent from the pairs above: @ix/pro collapsed it into
  // `ix bug list` (Ix-pro#108), so there is no plural command left to stub. The
  // singular stub has to cover the subcommand form instead — it swallows operands,
  // so `bug list` still reaches the sentinel rather than "unknown command".
  it("stubs the collapsed 'bug list' subcommand, not a 'bugs' command", () => {
    expect(runStub(["bug", "list", "--status", "open", "--format", "json"]).err).toContain(
      "The 'bug' command requires Ix Pro.",
    );
    expect(runStub(["bugs"]).err).not.toContain("requires Ix Pro");
  });

  it("emits the message verbatim as CLAUDE.md quotes it", () => {
    // Single quotes around the name, trailing period. Agents match on this.
    expect(runStub(["decide", "Use X"]).err).toContain("The 'decide' command requires Ix Pro.");
  });
});
