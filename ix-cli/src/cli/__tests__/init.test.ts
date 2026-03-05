import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock dependencies that init.ts imports so we can load it without side effects
vi.mock("../../client/api.js", () => ({
  IxClient: vi.fn().mockImplementation(() => ({
    health: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("../config.js", () => ({
  getEndpoint: vi.fn().mockReturnValue("http://localhost:8090"),
}));

let CLAUDE_MD: string;

beforeAll(async () => {
  const mod = await import("../commands/init.js");
  CLAUDE_MD = mod.IX_CLAUDE_MD_BLOCK;
});

describe("CLAUDE_MD template", () => {
  it("contains all 7 mandatory rules", () => {
    expect(CLAUDE_MD).toContain("ix_query");
    expect(CLAUDE_MD).toContain("ix_decide");
    expect(CLAUDE_MD).toContain("ix_conflicts");
    expect(CLAUDE_MD).toContain("NEVER guess");
    expect(CLAUDE_MD).toContain("ix_ingest");
    expect(CLAUDE_MD).toContain("ix://session/context");
    expect(CLAUDE_MD).toContain("ix_truth");
  });

  it("contains a Workflow section", () => {
    expect(CLAUDE_MD).toContain("## Workflow");
  });

  it("contains a What NOT to Do section", () => {
    expect(CLAUDE_MD).toContain("## What NOT to Do");
  });

  it("contains a Confidence Scores section", () => {
    expect(CLAUDE_MD).toContain("## Confidence Scores");
  });

  it("is under 80 lines to keep it concise", () => {
    const lines = CLAUDE_MD.split("\n");
    expect(lines.length).toBeLessThan(80);
  });

  it("has numbered rules 1-7 in the MANDATORY RULES section", () => {
    for (let i = 1; i <= 7; i++) {
      expect(CLAUDE_MD).toContain(`${i}.`);
    }
  });
});
