import { createHash } from "node:crypto";
import type { PatchOp } from "../../client/types.js";
import type { GitHubRepo, GitHubIssue, GitHubPR, GitHubCommit, GitHubComment } from "./fetch.js";

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

/**
 * Parse "fixes #N", "closes #N", "resolves #N" references from text.
 * Returns unique issue numbers referenced.
 */
export function parseFixesRefs(text: string | null | undefined): number[] {
  if (!text) return [];
  const pattern = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  const nums = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    nums.add(parseInt(match[1], 10));
  }
  return [...nums];
}

export function transformIssue(repo: GitHubRepo, issue: GitHubIssue): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/issues/${issue.number}`;
  const nodeId = deterministicId(uri);
  const isBug = issue.labels.some(l => /bug|defect/i.test(l.name));
  return [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "intent",
      name: issue.title,
      attrs: {
        number: issue.number,
        url: issue.html_url,
        author: issue.user?.login ?? "unknown",
        labels: issue.labels.map(l => l.name),
        state: issue.state,
        created_at: issue.created_at,
        body: truncate(issue.body, 2000),
        source_uri: uri,
        source: "github",
        github_type: "issue",
        is_bug: isBug,
      },
    },
  ];
}

export function transformIssueComment(
  repo: GitHubRepo, issueNumber: number, comment: GitHubComment
): PatchOp[] {
  const parentUri = `github://${repo.owner}/${repo.repo}/issues/${issueNumber}`;
  const commentUri = `${parentUri}/comments/${comment.id}`;
  const parentId = deterministicId(parentUri);
  const commentId = deterministicId(commentUri);
  const edgeId = deterministicId(`${parentUri}:CONTAINS:${commentUri}`);
  return [
    {
      type: "UpsertNode",
      id: commentId,
      kind: "doc",
      name: `Issue #${issueNumber} comment by ${comment.user?.login ?? "unknown"}`,
      attrs: {
        url: comment.html_url,
        author: comment.user?.login ?? "unknown",
        created_at: comment.created_at,
        body: truncate(comment.body, 2000),
        source_uri: commentUri,
        source: "github",
        github_type: "issue_comment",
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

export function transformPR(repo: GitHubRepo, pr: GitHubPR): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/pull/${pr.number}`;
  const nodeId = deterministicId(uri);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "decision",
      name: pr.title,
      attrs: {
        number: pr.number,
        url: pr.html_url,
        author: pr.user?.login ?? "unknown",
        state: pr.state,
        merged: !!pr.merged_at,
        base_branch: pr.base.ref,
        head_branch: pr.head.ref,
        created_at: pr.created_at,
        changed_files_count: pr.changed_files,
        body: truncate(pr.body, 2000),
        rationale: truncate(pr.body, 500),
        source_uri: uri,
        source: "github",
        github_type: "pull_request",
      },
    },
  ];

  // Create RESOLVES edges for "fixes #N" / "closes #N" references in PR body + title
  const fixedIssues = parseFixesRefs(`${pr.title}\n${pr.body ?? ""}`);
  for (const issueNum of fixedIssues) {
    const issueUri = `github://${repo.owner}/${repo.repo}/issues/${issueNum}`;
    const issueNodeId = deterministicId(issueUri);
    const edgeId = deterministicId(`${uri}:RESOLVES:${issueUri}`);
    ops.push({
      type: "UpsertEdge",
      id: edgeId,
      src: nodeId,
      dst: issueNodeId,
      predicate: "RESOLVES",
      attrs: { source: "github" },
    });
  }

  return ops;
}

export function transformPRComment(
  repo: GitHubRepo, prNumber: number, comment: GitHubComment
): PatchOp[] {
  const parentUri = `github://${repo.owner}/${repo.repo}/pull/${prNumber}`;
  const commentUri = `${parentUri}/comments/${comment.id}`;
  const parentId = deterministicId(parentUri);
  const commentId = deterministicId(commentUri);
  const edgeId = deterministicId(`${parentUri}:CONTAINS:${commentUri}`);
  return [
    {
      type: "UpsertNode",
      id: commentId,
      kind: "doc",
      name: `PR #${prNumber} review by ${comment.user?.login ?? "unknown"}`,
      attrs: {
        url: comment.html_url,
        author: comment.user?.login ?? "unknown",
        created_at: comment.created_at,
        body: truncate(comment.body, 2000),
        source_uri: commentUri,
        source: "github",
        github_type: "pr_comment",
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

export function transformCommit(repo: GitHubRepo, commit: GitHubCommit): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/commit/${commit.sha}`;
  const nodeId = deterministicId(uri);
  const message = commit.commit.message.split("\n")[0];
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "doc",
      name: message,
      attrs: {
        sha: commit.sha,
        url: commit.html_url,
        author: commit.commit.author?.name ?? "unknown",
        created_at: commit.commit.author?.date,
        message: truncate(commit.commit.message, 2000),
        changed_files: commit.files?.map(f => f.filename) ?? [],
        source_uri: uri,
        source: "github",
        github_type: "commit",
      },
    },
  ];
  if (commit.files) {
    for (const file of commit.files) {
      const fileNodeId = deterministicId(`${repo.owner}/${repo.repo}::${file.filename}`);
      const edgeId = deterministicId(`${uri}:REFERENCES:${file.filename}`);
      ops.push({
        type: "UpsertEdge",
        id: edgeId,
        src: nodeId,
        dst: fileNodeId,
        predicate: "REFERENCES",
        attrs: { change_type: file.status },
      });
    }
  }
  return ops;
}
