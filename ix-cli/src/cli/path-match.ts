/**
 * Shared `--path` matching helpers.
 *
 * `--path` is a substring match against a node's `provenance.source_uri`, and
 * source_uris are always POSIX: `ingest.ts`'s `toWorkspaceRelative` ends with
 * `rel.split(nodePath.sep).join('/')`, so a graph ingested on Windows stores
 * `src/cli/rank.ts` exactly as one ingested on Linux does.
 *
 * The user's input is not normalized anywhere, which is the bug: on Windows
 * `--path src\cli` is the natural thing to type (it is what tab-completion and
 * every error message give you) and it matched nothing at all in `rank` and
 * `inventory`, and nothing on the backend either, because no stored source_uri
 * ever contains a backslash. See Ix#636.
 *
 * Separators only — case is deliberately left alone. `--path` is
 * case-INSENSITIVE in the resolver (`read`, `explain`, `locate`, …) and
 * case-SENSITIVE in `rank`, `inventory` and the backend's AQL `CONTAINS`.
 * Reconciling that is a product decision with an index cost on the backend
 * side, and is tracked separately in Ix#636; this helper changes no case
 * behaviour in either direction.
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
