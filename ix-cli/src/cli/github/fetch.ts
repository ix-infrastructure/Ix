export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepo(input: string): GitHubRepo {
  const parts = input.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${input}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  changed_files?: number;
}

export interface GitHubCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  html_url: string;
  files?: { filename: string; status: string }[];
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

export interface GitHubFetchResult {
  issues: GitHubIssue[];
  issueComments: Map<number, GitHubComment[]>;
  pullRequests: GitHubPR[];
  prComments: Map<number, GitHubComment[]>;
  commits: GitHubCommit[];
}

async function ghFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function fetchGitHubData(
  repo: GitHubRepo,
  token: string,
  opts: { since?: string; limit?: number }
): Promise<GitHubFetchResult> {
  const { owner, repo: repoName } = repo;
  const base = `https://api.github.com/repos/${owner}/${repoName}`;
  const limit = opts.limit ?? 50;
  const sinceParam = opts.since ? `&since=${opts.since}` : "";

  const issues = await ghFetch<GitHubIssue[]>(
    `${base}/issues?state=all&per_page=${limit}&sort=updated&direction=desc${sinceParam}`,
    token
  );
  const realIssues = issues.filter((i: any) => !i.pull_request);

  const pullRequests = await ghFetch<GitHubPR[]>(
    `${base}/pulls?state=all&per_page=${limit}&sort=updated&direction=desc`,
    token
  );

  const commitLimit = Math.min(limit * 2, 100);
  const commits = await ghFetch<GitHubCommit[]>(
    `${base}/commits?per_page=${commitLimit}${sinceParam}`,
    token
  );

  const issueComments = new Map<number, GitHubComment[]>();
  for (const issue of realIssues.slice(0, 10)) {
    if (issue.comments > 0) {
      try {
        const comments = await ghFetch<GitHubComment[]>(
          `${base}/issues/${issue.number}/comments?per_page=10`,
          token
        );
        issueComments.set(issue.number, comments);
      } catch { /* skip on error */ }
    }
  }

  const prComments = new Map<number, GitHubComment[]>();
  for (const pr of pullRequests.slice(0, 10)) {
    try {
      const comments = await ghFetch<GitHubComment[]>(
        `${base}/pulls/${pr.number}/comments?per_page=10`,
        token
      );
      if (comments.length > 0) {
        prComments.set(pr.number, comments);
      }
    } catch { /* skip on error */ }
  }

  return { issues: realIssues, issueComments, pullRequests, prComments, commits };
}
