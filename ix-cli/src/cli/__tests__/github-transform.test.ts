// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";

describe("GitHub transform", () => {
  it("creates deterministic node IDs from URIs", async () => {
    const { deterministicId } = await import("../github/transform.js");
    const id1 = deterministicId("github://owner/repo/issues/1");
    const id2 = deterministicId("github://owner/repo/issues/1");
    const id3 = deterministicId("github://owner/repo/issues/2");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("transforms an issue into UpsertNode ops", async () => {
    const { transformIssue } = await import("../github/transform.js");
    const ops = transformIssue(
      { owner: "acme", repo: "app" },
      {
        number: 42, title: "Fix login bug", body: "Login fails on mobile",
        state: "open", user: { login: "alice" }, labels: [{ name: "bug" }],
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/acme/app/issues/42", comments: 0,
      }
    );
    expect(ops.length).toBeGreaterThanOrEqual(1);
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("intent");
    expect(upsert!.name).toBe("Fix login bug");
  });

  it("transforms a PR into UpsertNode ops with decision kind", async () => {
    const { transformPR } = await import("../github/transform.js");
    const ops = transformPR(
      { owner: "acme", repo: "app" },
      {
        number: 10, title: "Add auth flow", body: "Implements OAuth",
        state: "closed", merged_at: "2026-01-05T00:00:00Z",
        user: { login: "bob" }, base: { ref: "main" }, head: { ref: "feature/auth" },
        created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-05T00:00:00Z",
        html_url: "https://github.com/acme/app/pull/10", changed_files: 5,
      }
    );
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("decision");
    expect(upsert!.name).toBe("Add auth flow");
  });

  it("transforms a commit into UpsertNode ops with doc kind", async () => {
    const { transformCommit } = await import("../github/transform.js");
    const ops = transformCommit(
      { owner: "acme", repo: "app" },
      {
        sha: "abc123def456",
        commit: { message: "fix: resolve null pointer", author: { name: "carol", date: "2026-01-04T00:00:00Z" } },
        html_url: "https://github.com/acme/app/commit/abc123def456",
        files: [{ filename: "src/auth.ts", status: "modified" }],
      }
    );
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("doc");
    expect(upsert!.name).toContain("fix: resolve null pointer");
  });
});
