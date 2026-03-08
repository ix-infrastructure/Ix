import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve a GitHub token using this priority:
 * 1. Explicit --token flag
 * 2. GITHUB_TOKEN environment variable
 * 3. `gh auth token` CLI command
 */
export async function resolveGitHubToken(explicitToken?: string): Promise<string> {
  if (explicitToken) return explicitToken;

  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }

  throw new Error(
    "GitHub authentication required. Provide one of:\n" +
    "  --token <pat>           Personal access token\n" +
    "  GITHUB_TOKEN=<pat>      Environment variable\n" +
    "  gh auth login           GitHub CLI authentication"
  );
}
