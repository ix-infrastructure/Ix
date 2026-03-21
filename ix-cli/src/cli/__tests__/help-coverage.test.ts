import { describe, it, expect } from "vitest";
import { buildHelpText } from "../help-text.js";

/**
 * Verify that buildHelpText output mentions all core commands.
 * This prevents regression where new commands become invisible.
 */

const ossHelp = buildHelpText();

const REQUIRED_COMMANDS = [
  "init", "search", "locate", "explain", "impact", "overview", "watch",
  "read", "inventory", "rank", "history", "diff",
  "ingest", "status", "stats", "doctor", "docker",
];

describe("help coverage", () => {
  it("OSS help is non-empty", () => {
    expect(ossHelp.length).toBeGreaterThan(100);
  });

  it("OSS help mentions all core commands", () => {
    const missing: string[] = [];
    for (const cmd of REQUIRED_COMMANDS) {
      if (!ossHelp.includes(cmd)) {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });

  it("OSS help uses new branding", () => {
    expect(ossHelp).toContain("ix — Code Memory CLI");
    expect(ossHelp).not.toContain("Persistent Memory for LLM Systems");
  });

  it("OSS help does not show a Pro section", () => {
    expect(ossHelp).not.toContain("Pro:");
  });

  it("Pro help includes Pro section when commands provided", () => {
    const proHelp = buildHelpText([
      { name: "plan", desc: "Manage plans" },
      { name: "goal", desc: "Manage goals" },
    ]);
    expect(proHelp).toContain("Pro:");
    expect(proHelp).toContain("plan");
    expect(proHelp).toContain("Manage plans");
    expect(proHelp).toContain("goal");
  });
});
