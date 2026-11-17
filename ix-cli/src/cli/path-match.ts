// Copyright 2026 Ix Infrastructure Inc.

/**
 * Shared `--path` matching helpers.
 *
 * `--path` is a substring match against a node's `provenance.source_uri`, and
 * source_uris are always POSIX: `ingest.ts`'s `toWorkspaceRelative` ends with
 * `rel.split(nodePath.sep).join('/')`, so a graph ingested on Windows stores
 * `src/cli/rank.ts` exactly as one ingested on Linux does.
 *
 * The user's input was not normalized anywhere: on Windows `--path src\cli` is
 * the natural thing to type (it is what tab-completion and every error message
 * give you) and it matched nothing at all in `rank` and `inventory`, and nothing
 * on the backend either, because no stored source_uri ever contains a
 * backslash. See Ix#636.
 *
 * `--path` is also case-INSENSITIVE everywhere (Ix#636): the resolver (`read`,
 * `explain`, `locate`, …), the client-side filters in `rank` and `inventory`,
 * and the backend's `/v1/search` and `/v1/list` scopes all lowercase both
 * sides. A backend older than the release that made `/v1/list`'s scope
 * case-insensitive still matches the pushed-down scope case-sensitively, so
 * there `rank` and `inventory` can only find what that exact case matches.
 */

/**
 * Convert Windows separators to POSIX for substring matching.
 *
 * Applied to BOTH sides of every comparison. The stored side is POSIX by
 * construction today, but `github/transform.ts` builds source_uris of its own
 * and graphs ingested before the `toWorkspaceRelative` normalization landed can
 * still hold backslashes, so normalizing the node side too costs one pass and
 * removes the assumption.
 */
export function normalizePathSeparators(value: string | undefined | null): string {
  return (value ?? "").replace(/\\/g, "/");
}

/**
 * The `--path` comparison key: separators normalized as above, then lowercased.
 * Applied to both sides, so `--path ix-memory\src` matches `IX-Memory/src/a.ts`.
 */
export function normalizeForPathMatch(value: string | undefined | null): string {
  return normalizePathSeparators(value).toLowerCase();
}
