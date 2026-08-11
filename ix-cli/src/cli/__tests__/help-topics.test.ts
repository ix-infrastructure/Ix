import { describe, it, expect } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";

import { registerProStubs } from "../register/oss.js";
import { registerWorkflowsHelpCommand } from "../commands/workflows.js";

/**
 * Verify that the help command properly routes topic arguments
 * to the matching command's help, not just the workflows subcommand.
 */

const workflowsTsPath = path.resolve(__dirname, "../commands/workflows.ts");
const workflowsContent = fs.readFileSync(workflowsTsPath, "utf-8");

describe("help topic routing", () => {
  it("help command accepts an optional [topic] argument", () => {
    expect(workflowsContent).toContain('command("help [topic]")');
  });

  it("no-topic path uses program.helpInformation() (dynamic, bypasses Commander)", () => {
    expect(workflowsContent).toContain("program.helpInformation()");
    expect(workflowsContent).not.toContain('import { HELP_TEXT }');
  });

  it("help action looks up commands on the program", () => {
    expect(workflowsContent).toContain("program.commands.find");
    expect(workflowsContent).toContain("outputHelp");
  });

  it("help action handles the workflows topic directly", () => {
    expect(workflowsContent).toContain('topic === "workflows"');
    expect(workflowsContent).toContain("WORKFLOWS_TEXT");
  });

  it("help action handles the advanced topic directly", () => {
    expect(workflowsContent).toContain('topic === "advanced"');
    expect(workflowsContent).toContain("ADVANCED_TEXT");
  });

  it("help action handles unknown topics with an error", () => {
    expect(workflowsContent).toContain("Unknown help topic");
  });
});

/**
 * Behavioral coverage for the collapsed-plural forwarder. The assertions above
 * are source-text greps, which is how `ix help bugs` broke unnoticed: @ix/pro
 * collapsed `ix bugs` into `ix bug list` (Ix-pro#108) and dropping the `bugs`
 * stub left the topic resolving to nothing. Run the real command instead.
 */
describe("collapsed plural help topics resolve", () => {
  function runHelp(topic: string): { stdout: string; stderr: string; exitCode: number | string | undefined } {
    const program = new Command();
    program.name("ix").exitOverride();
    registerProStubs(program);
    registerWorkflowsHelpCommand(program);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = console.error;
    const origExit = process.exitCode;
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.error = (...a: unknown[]) => void stderr.push(a.join(" "));
    process.exitCode = undefined;

    let code: number | string | undefined;
    try {
      program.parse(["node", "ix", "help", topic]);
    } catch (e) {
      stderr.push(String((e as Error).message));
    } finally {
      code = process.exitCode;
      process.stdout.write = origWrite;
      console.error = origErr;
      process.exitCode = origExit;
    }
    return { stdout: stdout.join(""), stderr: stderr.join("\n"), exitCode: code };
  }

  it.each([
    ["bugs", "bug"],
    ["goals", "goal"],
  ])("ix help %s forwards to the %s command instead of erroring", (plural, singular) => {
    const { stdout, stderr, exitCode } = runHelp(plural);
    expect(stderr).not.toContain("Unknown help topic");
    expect(exitCode).toBeUndefined();
    // Anchored on a word boundary, not a prefix: `goals` is still a registered
    // Pro stub, and its own help starts `Usage: ix goals` — which *contains*
    // `Usage: ix goal`. Without the boundary this assertion passes with the
    // forwarder deleted outright, which is exactly how it was first written.
    expect(stdout).toMatch(new RegExp(`^Usage: ix ${singular}\\b`, "m"));
  });

  it("still rejects a topic that was never a command", () => {
    const { stderr, exitCode } = runHelp("nonsense");
    expect(stderr).toContain('Unknown help topic: "nonsense"');
    expect(exitCode).toBe(1);
  });
});
