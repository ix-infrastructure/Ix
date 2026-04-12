import { createHash } from "node:crypto";
import type { PatchOp } from "../../client/types.js";
import type { JiraIssue, JiraComment, JiraSprint } from "./fetch.js";
import { mapJiraStatus } from "./fetch.js";

/** Generate a deterministic UUID-like ID from a string. */
export function deterministicId(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Parse a Jira issue key like "PROJ-123" */
export function parseJiraKey(key: string): { project: string; number: number } | null {
  const match = key.match(/^([A-Z][A-Z0-9_]+)-(\d+)$/);
  if (!match) return null;
  return { project: match[1], number: parseInt(match[2], 10) };
}

// ── Issue type detection ────────────────────────────────────────────

const BUG_TYPES = new Set(["bug", "defect", "incident"]);
const EPIC_TYPES = new Set(["epic"]);

function isBugType(issue: JiraIssue): boolean {
  const typeName = issue.fields.issuetype.name.toLowerCase();
  if (BUG_TYPES.has(typeName)) return true;
  return issue.fields.labels.some((l) => /bug|defect/i.test(l));
}

function isEpicType(issue: JiraIssue): boolean {
  return EPIC_TYPES.has(issue.fields.issuetype.name.toLowerCase());
}

// ── Jira description → plain text ──────────────────────────────────

function adfToPlainText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.content && Array.isArray(node.content)) {
    return node.content.map(adfToPlainText).join("");
  }
  return "";
}

function descriptionText(desc: any): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // ADF (Atlassian Document Format)
  return adfToPlainText(desc);
}

// ── Transforms ──────────────────────────────────────────────────────

export function transformIssue(baseUrl: string, issue: JiraIssue): PatchOp[] {
  const uri = `jira://${issue.key}`;
  const nodeId = deterministicId(uri);
  const isBug = isBugType(issue);
  const isEpic = isEpicType(issue);
  const description = descriptionText(issue.fields.description);

  // Map Jira issue types to graph node kinds:
  //   Epic → goal, Bug → intent (is_bug=true), Story/Task/Sub-task → intent
  const kind = isEpic ? "goal" : "intent";
  const jiraType = isEpic
    ? "epic"
    : isBug
      ? "bug"
      : issue.fields.issuetype.name.toLowerCase();

  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind,
      name: issue.fields.summary,
      attrs: {
        jira_key: issue.key,
        jira_id: issue.id,
        url: `${baseUrl}/browse/${issue.key}`,
        author: issue.fields.reporter?.displayName ?? "unknown",
        assignee: issue.fields.assignee?.displayName ?? null,
        labels: issue.fields.labels,
        state: mapJiraStatus(issue.fields.status.name),
        jira_status: issue.fields.status.name,
        priority: issue.fields.priority?.name ?? null,
        created_at: issue.fields.created,
        updated_at: issue.fields.updated,
        resolved_at: issue.fields.resolutiondate ?? null,
        body: truncate(description, 2000),
        source_uri: uri,
        source: "jira",
        jira_type: jiraType,
        is_bug: isBug,
      },
    },
  ];

  // Create PART_OF edge to parent epic if present
  if (issue.fields.parent) {
    const parentUri = `jira://${issue.fields.parent.key}`;
    const parentId = deterministicId(parentUri);
    const edgeId = deterministicId(`${uri}:PART_OF:${parentUri}`);
    ops.push({
      type: "UpsertEdge",
      id: edgeId,
      src: nodeId,
      dst: parentId,
      predicate: "PART_OF",
      attrs: { source: "jira" },
    });
  }

  return ops;
}

export function transformComment(
  issue: JiraIssue,
  comment: JiraComment,
): PatchOp[] {
  const parentUri = `jira://${issue.key}`;
  const commentUri = `${parentUri}/comments/${comment.id}`;
  const parentId = deterministicId(parentUri);
  const commentId = deterministicId(commentUri);
  const edgeId = deterministicId(`${parentUri}:CONTAINS:${commentUri}`);

  return [
    {
      type: "UpsertNode",
      id: commentId,
      kind: "doc",
      name: `${issue.key} comment by ${comment.author?.displayName ?? "unknown"}`,
      attrs: {
        jira_key: issue.key,
        author: comment.author?.displayName ?? "unknown",
        created_at: comment.created,
        body: truncate(comment.body, 2000),
        source_uri: commentUri,
        source: "jira",
        jira_type: "comment",
      },
    },
    {
      type: "UpsertEdge",
      id: edgeId,
      src: parentId,
      dst: commentId,
      predicate: "CONTAINS",
      attrs: {},
    },
  ];
}

export function transformSprint(baseUrl: string, sprint: JiraSprint): PatchOp[] {
  const uri = `jira://sprint/${sprint.id}`;
  const nodeId = deterministicId(uri);

  return [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "plan",
      name: sprint.name,
      attrs: {
        jira_sprint_id: sprint.id,
        state: sprint.state,
        start_date: sprint.startDate ?? null,
        end_date: sprint.endDate ?? null,
        complete_date: sprint.completeDate ?? null,
        goal: sprint.goal ?? null,
        source_uri: uri,
        source: "jira",
        jira_type: "sprint",
      },
    },
  ];
}
