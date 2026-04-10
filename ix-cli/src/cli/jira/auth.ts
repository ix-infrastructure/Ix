/**
 * Resolve Jira credentials using this priority:
 * 1. Explicit --token / --email / --url flags
 * 2. Environment variables: JIRA_TOKEN, JIRA_EMAIL, JIRA_URL
 */

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

export function resolveJiraCredentials(opts?: {
  url?: string;
  email?: string;
  token?: string;
}): JiraCredentials {
  const baseUrl = opts?.url ?? process.env.JIRA_URL;
  const email = opts?.email ?? process.env.JIRA_EMAIL;
  const token = opts?.token ?? process.env.JIRA_TOKEN;

  if (!baseUrl) {
    throw new Error(
      "Jira URL required. Provide one of:\n" +
      "  --url <url>         Jira instance URL (e.g. https://myorg.atlassian.net)\n" +
      "  JIRA_URL=<url>      Environment variable"
    );
  }

  if (!email) {
    throw new Error(
      "Jira email required. Provide one of:\n" +
      "  --email <email>     Atlassian account email\n" +
      "  JIRA_EMAIL=<email>  Environment variable"
    );
  }

  if (!token) {
    throw new Error(
      "Jira API token required. Provide one of:\n" +
      "  --token <token>         API token (from id.atlassian.com)\n" +
      "  JIRA_TOKEN=<token>      Environment variable"
    );
  }

  // Normalize: strip trailing slash
  const normalizedUrl = baseUrl.replace(/\/+$/, "");

  return { baseUrl: normalizedUrl, email, token };
}
