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

  it("transforms an issue into UpsertNode with intent kind and github attrs", async () => {
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
    expect((upsert as any).attrs.source).toBe("github");
    expect((upsert as any).attrs.github_type).toBe("issue");
    expect((upsert as any).attrs.is_bug).toBe(true);
  });

  it("marks non-bug issues with is_bug false", async () => {
    const { transformIssue } = await import("../github/transform.js");
    const ops = transformIssue(
      { owner: "acme", repo: "app" },
      {
        number: 43, title: "Add feature", body: "New feature request",
        state: "open", user: { login: "bob" }, labels: [{ name: "enhancement" }],
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/acme/app/issues/43", comments: 0,
      }
    );
    const upsert = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(upsert.attrs.is_bug).toBe(false);
  });

  it("transforms a PR into UpsertNode with decision kind and github attrs", async () => {
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
    expect((upsert as any).attrs.source).toBe("github");
    expect((upsert as any).attrs.github_type).toBe("pull_request");
  });

  it("creates RESOLVES edges when PR body references issues", async () => {
    const { transformPR, deterministicId } = await import("../github/transform.js");
    const ops = transformPR(
      { owner: "acme", repo: "app" },
      {
        number: 11, title: "Fix auth", body: "Fixes #42 and closes #43",
        state: "closed", merged_at: "2026-01-05T00:00:00Z",
        user: { login: "bob" }, base: { ref: "main" }, head: { ref: "fix/auth" },
        created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-05T00:00:00Z",
        html_url: "https://github.com/acme/app/pull/11", changed_files: 2,
      }
    );
    const edges = ops.filter((op: any) => op.type === "UpsertEdge" && op.predicate === "RESOLVES");
    expect(edges.length).toBe(2);
    // Verify edge destinations match the expected issue node IDs
    const issue42Id = deterministicId("github://acme/app/issues/42");
    const issue43Id = deterministicId("github://acme/app/issues/43");
    const dstIds = edges.map((e: any) => e.dst);
    expect(dstIds).toContain(issue42Id);
    expect(dstIds).toContain(issue43Id);
  });

  it("transforms a commit into UpsertNode with doc kind and github attrs", async () => {
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
    expect((upsert as any).attrs.source).toBe("github");
    expect((upsert as any).attrs.github_type).toBe("commit");
  });

  it("parseFixesRefs extracts issue numbers from various patterns", async () => {
    const { parseFixesRefs } = await import("../github/transform.js");
    expect(parseFixesRefs("Fixes #42")).toEqual([42]);
    expect(parseFixesRefs("closes #10 and fixes #20")).toEqual([10, 20]);
    expect(parseFixesRefs("Resolved #5")).toEqual([5]);
    expect(parseFixesRefs("Fixed #1, closes #2, resolves #3")).toEqual([1, 2, 3]);
    expect(parseFixesRefs("No references here")).toEqual([]);
    expect(parseFixesRefs(null)).toEqual([]);
    expect(parseFixesRefs(undefined)).toEqual([]);
    // Deduplicates
    expect(parseFixesRefs("Fixes #42 and also fixes #42")).toEqual([42]);
  });
});
