import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("GitHub auth resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses --token flag when provided", async () => {
    const { resolveGitHubToken } = await import("../github/auth.js");
    const token = await resolveGitHubToken("my-pat-token");
    expect(token).toBe("my-pat-token");
  });

  it("uses GITHUB_TOKEN env when no --token", async () => {
    process.env.GITHUB_TOKEN = "env-token-123";
    const { resolveGitHubToken } = await import("../github/auth.js");
    const token = await resolveGitHubToken(undefined);
    expect(token).toBe("env-token-123");
  });
});
