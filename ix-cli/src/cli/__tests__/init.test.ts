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
  it("contains mandatory rules and CLI command routing", () => {
    expect(CLAUDE_MD).toContain("ix decide");
    expect(CLAUDE_MD).toContain("ix conflicts");
    expect(CLAUDE_MD).toContain("NEVER guess");
    expect(CLAUDE_MD).toContain("ix ingest");
    expect(CLAUDE_MD).toContain("ix truth");
    expect(CLAUDE_MD).toContain("ix search");
    expect(CLAUDE_MD).toContain("ix explain");
    expect(CLAUDE_MD).toContain("ix callers");
  });

  it("routes through CLI exclusively, not MCP", () => {
    expect(CLAUDE_MD).toContain("ix` CLI exclusively");
    expect(CLAUDE_MD).toContain("Do NOT use MCP");
  });

  it("contains a Do NOT Use section", () => {
    expect(CLAUDE_MD).toContain("## Do NOT Use");
  });

  it("contains a Confidence Scores section", () => {
    expect(CLAUDE_MD).toContain("## Confidence Scores");
  });

  it("is under 80 lines to keep it concise", () => {
    const lines = CLAUDE_MD.split("\n");
    expect(lines.length).toBeLessThan(80);
  });

  it("has numbered rules 1-6 in the MANDATORY RULES section", () => {
    for (let i = 1; i <= 6; i++) {
      expect(CLAUDE_MD).toContain(`${i}.`);
    }
  });
});
