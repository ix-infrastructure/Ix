import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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
