import type { JiraCredentials } from "./auth.js";

// ── Jira API Types ──────────────────────────────────────────────────

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraStatus {
  name: string;
  statusCategory: { key: string; name: string };
}

export interface JiraPriority {
  name: string;
}

export interface JiraIssueType {
  name: string;
  subtask: boolean;
}

export interface JiraIssueFields {
  summary: string;
  description: string | null;
  status: JiraStatus;
  priority: JiraPriority | null;
  issuetype: JiraIssueType;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  labels: string[];
  created: string;
  updated: string;
  resolutiondate: string | null;
  parent?: { key: string; fields?: { summary?: string; issuetype?: JiraIssueType } };
  comment?: { comments: JiraComment[]; total: number };
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraComment {
  id: string;
  body: string;
  author: JiraUser;
  created: string;
  updated: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string; // "active" | "closed" | "future"
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface JiraFetchResult {
  issues: JiraIssue[];
  sprints: JiraSprint[];
}

// ── Status mapping ──────────────────────────────────────────────────

const DEFAULT_STATUS_MAP: Record<string, string> = {
  "to do": "pending",
  "open": "pending",
  "backlog": "pending",
  "in progress": "in_progress",
  "in review": "in_progress",
  "done": "done",
  "closed": "done",
  "resolved": "done",
};

export function mapJiraStatus(jiraStatus: string): string {
  return DEFAULT_STATUS_MAP[jiraStatus.toLowerCase()] ?? "pending";
}

// ── API client ──────────────────────────────────────────────────────

async function jiraFetch<T>(
  creds: JiraCredentials,
  path: string,
): Promise<T> {
  const url = `${creds.baseUrl}/rest/api/3/${path}`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");

  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jira API ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}

async function jiraAgileGet<T>(
  creds: JiraCredentials,
  path: string,
): Promise<T> {
  const url = `${creds.baseUrl}/rest/agile/1.0/${path}`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");

  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jira Agile API ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}

// ── Transition helper ───────────────────────────────────────────────

export async function transitionIssue(
  creds: JiraCredentials,
  issueKey: string,
  targetStatus: string,
): Promise<{ transitioned: boolean; transitionName?: string }> {
  const url = `${creds.baseUrl}/rest/api/3/issue/${issueKey}/transitions`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");

  // Get available transitions
  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Jira transitions ${resp.status}`);
  const { transitions } = (await resp.json()) as {
    transitions: { id: string; name: string; to: { name: string } }[];
  };

  // Find matching transition
  const match = transitions.find(
    (t) => t.to.name.toLowerCase() === targetStatus.toLowerCase(),
  );
  if (!match) return { transitioned: false };

  // Execute transition
  const execResp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  if (!execResp.ok) {
    const text = await execResp.text();
    throw new Error(`Jira transition failed ${execResp.status}: ${text}`);
  }

  return { transitioned: true, transitionName: match.name };
}

// ── Fetch orchestrator ──────────────────────────────────────────────

export async function fetchJiraData(
  creds: JiraCredentials,
  projectKey: string,
  opts: { since?: string; limit?: number; jql?: string },
): Promise<JiraFetchResult> {
  const limit = opts.limit ?? 50;

  // Build JQL
  let jql = opts.jql ?? `project = ${projectKey}`;
  if (opts.since) {
    jql += ` AND updated >= "${opts.since}"`;
  }
  jql += " ORDER BY updated DESC";

  const encodedJql = encodeURIComponent(jql);
  const fields = "summary,description,status,priority,issuetype,assignee,reporter,labels,created,updated,resolutiondate,parent,comment";

  const searchResult = await jiraFetch<{
    issues: JiraIssue[];
    total: number;
  }>(creds, `search?jql=${encodedJql}&maxResults=${limit}&fields=${fields}`);

  // Fetch sprints via Agile API (board-based)
  let sprints: JiraSprint[] = [];
  try {
    const boards = await jiraAgileGet<{
      values: { id: number; name: string }[];
    }>(creds, `board?projectKeyOrId=${projectKey}&maxResults=1`);

    if (boards.values.length > 0) {
      const boardId = boards.values[0].id;
      const sprintResult = await jiraAgileGet<{
        values: JiraSprint[];
      }>(creds, `board/${boardId}/sprint?maxResults=10&state=active,closed,future`);
      sprints = sprintResult.values;
    }
  } catch {
    // Agile API may not be available or board may not exist
  }

  return { issues: searchResult.issues, sprints };
}
