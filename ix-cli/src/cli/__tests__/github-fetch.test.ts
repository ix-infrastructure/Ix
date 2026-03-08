import { describe, it, expect } from "vitest";

describe("parseGitHubRepo", () => {
  it("parses owner/repo format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(parseGitHubRepo("ix-infrastructure/IX-Memory")).toEqual({
      owner: "ix-infrastructure",
      repo: "IX-Memory",
    });
  });

  it("throws on invalid format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(() => parseGitHubRepo("invalid")).toThrow();
  });
});
