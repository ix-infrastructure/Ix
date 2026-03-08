import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock the MCP SDK to prevent server startup side effects
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(),
    resource: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../../client/api.js", () => ({
  IxClient: vi.fn().mockImplementation(() => ({})),
}));

let INSTRUCTIONS: string;

beforeAll(async () => {
  const mod = await import("../server.js");
  INSTRUCTIONS = mod.INSTRUCTIONS;
});

describe("MCP server INSTRUCTIONS", () => {
  it("contains mandatory rules and key tool references", () => {
    expect(INSTRUCTIONS).toContain("ix_query");
    expect(INSTRUCTIONS).toContain("ix_decide");
    expect(INSTRUCTIONS).toContain("ix_conflicts");
    expect(INSTRUCTIONS).toContain("NEVER answer from training data alone");
    expect(INSTRUCTIONS).toContain("ix_ingest");
    expect(INSTRUCTIONS).toContain("ix_truth");
  });

  it("is under 40 lines to stay concise", () => {
    const lines = INSTRUCTIONS.split("\n");
    expect(lines.length).toBeLessThan(40);
  });

  it("contains behavioral checks section", () => {
    expect(INSTRUCTIONS).toContain("BEHAVIORAL CHECKS");
  });

  it("notes CLI is canonical interface", () => {
    expect(INSTRUCTIONS).toContain("ix CLI is now the canonical agent interface");
  });

  it("describes what Ix returns", () => {
    expect(INSTRUCTIONS).toContain("nodes, edges, claims, conflicts, and decisions");
    expect(INSTRUCTIONS).toContain("confidence scores");
  });
});
