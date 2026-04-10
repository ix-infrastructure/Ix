import { describe, it, expect } from "vitest";

describe("Jira transform", () => {
  it("creates deterministic node IDs from Jira URIs", async () => {
    const { deterministicId } = await import("../jira/transform.js");
    const id1 = deterministicId("jira://PROJ-123");
    const id2 = deterministicId("jira://PROJ-123");
    const id3 = deterministicId("jira://PROJ-456");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("parseJiraKey extracts project and number", async () => {
    const { parseJiraKey } = await import("../jira/transform.js");
    expect(parseJiraKey("PROJ-123")).toEqual({ project: "PROJ", number: 123 });
    expect(parseJiraKey("MY_TEAM-42")).toEqual({ project: "MY_TEAM", number: 42 });
    expect(parseJiraKey("invalid")).toBeNull();
    expect(parseJiraKey("123-ABC")).toBeNull();
  });

  it("transforms a story into intent node with jira attrs", async () => {
    const { transformIssue } = await import("../jira/transform.js");
    const ops = transformIssue("https://myorg.atlassian.net", {
      id: "10001",
      key: "PROJ-42",
      self: "https://myorg.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Add user onboarding flow",
        description: null,
        status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
        priority: { name: "High" },
        issuetype: { name: "Story", subtask: false },
        assignee: { accountId: "123", displayName: "Alice" },
        reporter: { accountId: "456", displayName: "Bob" },
        labels: ["frontend"],
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-05T00:00:00.000+0000",
        resolutiondate: null,
      },
    });
    const upsert = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(upsert).toBeDefined();
    expect(upsert.kind).toBe("intent");
    expect(upsert.name).toBe("Add user onboarding flow");
    expect(upsert.attrs.source).toBe("jira");
    expect(upsert.attrs.jira_type).toBe("story");
    expect(upsert.attrs.jira_key).toBe("PROJ-42");
    expect(upsert.attrs.assignee).toBe("Alice");
    expect(upsert.attrs.state).toBe("in_progress");
    expect(upsert.attrs.is_bug).toBe(false);
  });

  it("transforms a bug into intent node with is_bug=true", async () => {
    const { transformIssue } = await import("../jira/transform.js");
    const ops = transformIssue("https://myorg.atlassian.net", {
      id: "10002",
      key: "PROJ-43",
      self: "https://myorg.atlassian.net/rest/api/3/issue/10002",
      fields: {
        summary: "Login page crashes on Safari",
        description: null,
        status: { name: "Open", statusCategory: { key: "new", name: "To Do" } },
        priority: { name: "Critical" },
        issuetype: { name: "Bug", subtask: false },
        assignee: null,
        reporter: { accountId: "456", displayName: "Bob" },
        labels: [],
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-02T00:00:00.000+0000",
        resolutiondate: null,
      },
    });
    const upsert = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(upsert.kind).toBe("intent");
    expect(upsert.attrs.jira_type).toBe("bug");
    expect(upsert.attrs.is_bug).toBe(true);
    expect(upsert.attrs.state).toBe("pending");
  });

  it("transforms an epic into goal node", async () => {
    const { transformIssue } = await import("../jira/transform.js");
    const ops = transformIssue("https://myorg.atlassian.net", {
      id: "10003",
      key: "PROJ-10",
      self: "https://myorg.atlassian.net/rest/api/3/issue/10003",
      fields: {
        summary: "User Authentication Overhaul",
        description: null,
        status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
        priority: { name: "High" },
        issuetype: { name: "Epic", subtask: false },
        assignee: { accountId: "123", displayName: "Alice" },
        reporter: { accountId: "456", displayName: "Bob" },
        labels: ["auth"],
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-10T00:00:00.000+0000",
        resolutiondate: null,
      },
    });
    const upsert = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(upsert.kind).toBe("goal");
    expect(upsert.attrs.jira_type).toBe("epic");
    expect(upsert.attrs.source).toBe("jira");
  });

  it("creates PART_OF edge when issue has parent epic", async () => {
    const { transformIssue, deterministicId } = await import("../jira/transform.js");
    const ops = transformIssue("https://myorg.atlassian.net", {
      id: "10004",
      key: "PROJ-50",
      self: "https://myorg.atlassian.net/rest/api/3/issue/10004",
      fields: {
        summary: "Implement OAuth login",
        description: null,
        status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
        priority: { name: "Medium" },
        issuetype: { name: "Story", subtask: false },
        assignee: null,
        reporter: { accountId: "456", displayName: "Bob" },
        labels: [],
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-02T00:00:00.000+0000",
        resolutiondate: null,
        parent: { key: "PROJ-10", fields: { summary: "Auth Overhaul", issuetype: { name: "Epic", subtask: false } } },
      },
    });
    const edges = ops.filter((op: any) => op.type === "UpsertEdge" && op.predicate === "PART_OF");
    expect(edges.length).toBe(1);
    const edge = edges[0] as any;
    expect(edge.dst).toBe(deterministicId("jira://PROJ-10"));
    expect(edge.attrs.source).toBe("jira");
  });

  it("transforms a sprint into plan node", async () => {
    const { transformSprint } = await import("../jira/transform.js");
    const ops = transformSprint("https://myorg.atlassian.net", {
      id: 101,
      name: "Sprint 14",
      state: "active",
      startDate: "2026-01-06T00:00:00.000Z",
      endDate: "2026-01-20T00:00:00.000Z",
      goal: "Ship auth overhaul",
    });
    const upsert = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(upsert).toBeDefined();
    expect(upsert.kind).toBe("plan");
    expect(upsert.name).toBe("Sprint 14");
    expect(upsert.attrs.source).toBe("jira");
    expect(upsert.attrs.jira_type).toBe("sprint");
    expect(upsert.attrs.goal).toBe("Ship auth overhaul");
  });

  it("transforms a comment with CONTAINS edge", async () => {
    const { transformComment } = await import("../jira/transform.js");
    const issue = {
      id: "10001",
      key: "PROJ-42",
      self: "https://myorg.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Test issue",
        description: null,
        status: { name: "Open", statusCategory: { key: "new", name: "To Do" } },
        priority: null,
        issuetype: { name: "Task", subtask: false },
        assignee: null,
        reporter: null,
        labels: [],
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-02T00:00:00.000+0000",
        resolutiondate: null,
      },
    };
    const ops = transformComment(issue, {
      id: "20001",
      body: "This needs more investigation",
      author: { accountId: "123", displayName: "Alice" },
      created: "2026-01-03T00:00:00.000+0000",
      updated: "2026-01-03T00:00:00.000+0000",
    });
    expect(ops.length).toBe(2);
    const node = ops.find((op: any) => op.type === "UpsertNode") as any;
    expect(node.kind).toBe("doc");
    expect(node.attrs.source).toBe("jira");
    expect(node.attrs.jira_type).toBe("comment");
    const edge = ops.find((op: any) => op.type === "UpsertEdge") as any;
    expect(edge.predicate).toBe("CONTAINS");
  });
});
