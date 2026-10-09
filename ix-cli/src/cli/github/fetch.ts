// Copyright 2026 Ix Infrastructure Inc.

export interface GitHubRepo {
  owner: string;
  repo: string;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export function parseGitHubRepo(input: string): GitHubRepo {
  const parts = input.split("/");
  // Each part goes into an API URL path, so `..`, `.`, or anything outside
  // GitHub's own name alphabet would change which endpoint is requested.
  const valid = (p: string | undefined): p is string => !!p && GITHUB_NAME.test(p) && p !== "." && p !== "..";
  if (parts.length !== 2 || !valid(parts[0]) || !valid(parts[1])) {
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

/** GitHub serves at most this many items a page, whatever `per_page` asks for. */
const GITHUB_PAGE_MAX = 100;

/**
 * Up to `want` items of a list endpoint, page by page. `per_page` alone
 * silently capped every list at 100: `--limit 300` fetched 100 issues.
 * `url` carries its own query string, without `per_page` or `page`.
 */
export async function ghFetchList<T>(
  url: string,
  token: string,
  want: number,
  fetchPage: (url: string, token: string) => Promise<T[]> = ghFetch,
): Promise<T[]> {
  const perPage = Math.max(1, Math.min(want, GITHUB_PAGE_MAX));
  const out: T[] = [];
  for (let page = 1; out.length < want; page++) {
    const sep = url.includes("?") ? "&" : "?";
    const items = await fetchPage(`${url}${sep}per_page=${perPage}&page=${page}`, token);
    out.push(...items.slice(0, want - out.length));
    if (items.length < perPage) break;
  }
  return out;
}

export async function fetchGitHubData(
  repo: GitHubRepo,
  token: string,
  opts: { since?: string; limit?: number }
): Promise<GitHubFetchResult> {
  const { owner, repo: repoName } = repo;
  const base = `https://api.github.com/repos/${owner}/${repoName}`;
  const limit = opts.limit ?? 50;
  const sinceParam = opts.since ? `&since=${encodeURIComponent(opts.since)}` : "";

  const issues = await ghFetchList<GitHubIssue>(
    `${base}/issues?state=all&sort=updated&direction=desc${sinceParam}`,
    token,
    limit,
  );
  const realIssues = issues.filter((i: any) => !i.pull_request);

  const pullRequests = await ghFetchList<GitHubPR>(
    `${base}/pulls?state=all&sort=updated&direction=desc`,
    token,
    limit,
  );

  const commits = await ghFetchList<GitHubCommit>(
    `${base}/commits?${sinceParam.slice(1)}`.replace(/\?$/, ""),
    token,
    limit * 2,
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
