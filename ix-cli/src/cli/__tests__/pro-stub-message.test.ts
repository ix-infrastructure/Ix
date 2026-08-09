import { describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerProStubs } from "../register/oss.js";

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
    ["bugs", ["bugs", "--status", "open", "--format", "json"]],
    ["truth", ["truth", "add", "Support 100k file repos"]],
    ["truth", ["truth", "list", "--format", "json"]],
    ["goal", ["goal", "create", "Support GitHub", "--format", "json"]],
    ["decide", ["decide", "Use X", "--rationale", "because", "--affects", "Entity"]],
    ["briefing", ["briefing", "--format", "json"]],
    ["decisions", ["decisions", "--topic", "ingestion", "--limit", "10"]],
    ["patches", ["patches", "--limit", "20", "--format", "json"]],
    ["plan", ["plan", "task", "title", "--plan", "p1", "--resolves", "b1"]],
    ["task", ["task", "show", "t1"]],
    ["workflow", ["workflow", "attach", "w1"]],
  ])("reports Pro for %s with arguments", (name, argv) => {
    const { err, exitCode } = runStub(argv);
    expect(err).toContain(`The '${name}' command requires Ix Pro.`);
    expect(err).not.toContain("too many arguments");
    expect(exitCode).toBe(1);
  });

  it("emits the message verbatim as CLAUDE.md quotes it", () => {
    // Single quotes around the name, trailing period. Agents match on this.
    expect(runStub(["decide", "Use X"]).err).toContain("The 'decide' command requires Ix Pro.");
  });
});
