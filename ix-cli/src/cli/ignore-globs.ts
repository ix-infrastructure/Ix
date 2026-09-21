// Copyright 2026 Ix Infrastructure Inc.

/**
 * `.ixignore` and `ingest --exclude <glob>`.
 *
 * A fixture-heavy repository puts its fixtures in the graph, the map and every
 * search result: Django's test tree and Vite's playground are most of what
 * those repositories contain by file count, and none of it is what someone
 * asking about the repository means. `IGNORE_DIRS` covers the conventional
 * names, but only those, and only for the filesystem walk — `git ls-files`,
 * which is the discovery path in any git repository, never saw it.
 *
 * ## Matching, deliberately a subset of .gitignore
 *
 * Supported: `#` comments, blank lines, `*` (any run of characters except a
 * separator), `?` (one character except a separator), `**` (any run of path
 * segments), a leading `/` to anchor at the ingest root, and a trailing `/` to
 * mean directories only. A pattern with no separator matches at any depth, as
 * in `.gitignore` — `fixtures/` excludes every `fixtures` directory.
 *
 * Not supported, and the file is not silently pretending otherwise: `!`
 * negation and character classes. Both are answers to "I excluded too much",
 * and the honest fix for that is a narrower pattern.
 *
 * ## No regex
 *
 * Patterns arrive from a file inside the repository being ingested, which is
 * untrusted input on the one path in this CLI that parses arbitrary
 * repositories. Compiling a glob to a regex is where `**a**a**b` becomes a
 * catastrophic backtrack, so this matches directly: the classic two-pointer
 * wildcard walk, which remembers the last `*` it passed and resumes there
 * instead of recursing. Worst case is O(pattern x path) with no stack and no
 * exponential blowup.
 */

/** Longest a single pattern may be. A line past this is malformed, not a glob. */
const MAX_PATTERN_LENGTH = 1024;

export interface IgnorePattern {
  /** Segments of the pattern, `/`-split. */
  segments: string[];
  /** The pattern ended in `/`: it matches directories and what is under them. */
  directoryOnly: boolean;
  /** The pattern began with `/`: it matches from the ingest root only. */
  anchored: boolean;
  /** The text as written, for reporting. */
  source: string;
}

/**
 * One path segment against one pattern segment, with `*` and `?`.
 *
 * Two pointers and a remembered star position — no recursion, no regex. On a
 * mismatch after a `*`, the walk resumes one character further along the input
 * rather than re-entering the matcher.
 */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;

  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starT = t;
      p += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Pattern segments against path segments, with `**`.
 *
 * Same shape one level up: `**` is the star, and a mismatch after one resumes
 * a segment further along.
 */
function segmentsMatch(pattern: string[], path: string[]): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;

  while (t < path.length) {
    if (p < pattern.length && pattern[p] !== "**" && segmentMatches(pattern[p], path[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "**") {
      starP = p;
      starT = t;
      p += 1;
    } else if (starP >= 0) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "**") p += 1;
  return p === pattern.length;
}

/** Parse one line. Returns null for a comment, a blank line, or an overlong one. */
export function parseIgnorePattern(line: string): IgnorePattern | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (trimmed.length > MAX_PATTERN_LENGTH) return null;
  // `!` is not supported, and a pattern that starts with one is more likely a
  // caller expecting negation than a file literally named `!x`. Dropping it
  // beats excluding the opposite of what they meant.
  if (trimmed.startsWith("!")) return null;

  const directoryOnly = trimmed.endsWith("/");
  const body = directoryOnly ? trimmed.slice(0, -1) : trimmed;
  const anchored = body.startsWith("/");
  const normalized = (anchored ? body.slice(1) : body).replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  return { segments, directoryOnly, anchored, source: trimmed };
}

/** Every usable pattern in a `.ixignore`-shaped file. */
export function parseIgnoreFile(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseIgnorePattern(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface IgnoreMatcher {
  /** True when this workspace-relative path is excluded. */
  matches(relativePath: string, isDirectory?: boolean): boolean;
  /** How many patterns are in force. Zero means the matcher is a no-op. */
  readonly size: number;
}

/**
 * A matcher over parsed patterns.
 *
 * An unanchored pattern matches at any depth, which is what makes `fixtures/`
 * mean every `fixtures` directory rather than only one at the root. A
 * directory-only pattern also excludes everything beneath it, because that is
 * the only reading of `fixtures/` anyone means.
 */
export function createIgnoreMatcher(patterns: IgnorePattern[]): IgnoreMatcher {
  return {
    size: patterns.length,
    matches(relativePath: string, isDirectory = false): boolean {
      const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
      const segments = path.split("/").filter((s) => s !== "");
      if (segments.length === 0) return false;

      for (const pattern of patterns) {
        if (pattern.directoryOnly && !isDirectory) {
          // A file is still excluded when a directory pattern matches one of
          // its parents — `fixtures/` means the tree, not the entry.
          if (matchesAnyPrefix(pattern, segments)) return true;
          continue;
        }
        if (matchesAt(pattern, segments)) return true;
        if (pattern.directoryOnly && matchesAnyPrefix(pattern, segments)) return true;
        // A file under an excluded directory, where the pattern had no
        // trailing slash: `docs/generated` excludes `docs/generated/a.ts`.
        if (!pattern.directoryOnly && matchesAnyPrefix(pattern, segments)) return true;
      }
      return false;
    },
  };
}

function matchesAt(pattern: IgnorePattern, segments: string[]): boolean {
  if (pattern.anchored) return segmentsMatch(pattern.segments, segments);
  // Unanchored: try every suffix, so a bare name matches at any depth.
  for (let i = 0; i < segments.length; i += 1) {
    if (segmentsMatch(pattern.segments, segments.slice(i))) return true;
  }
  return false;
}

/** True when the pattern matches some proper ancestor of this path. */
function matchesAnyPrefix(pattern: IgnorePattern, segments: string[]): boolean {
  for (let end = 1; end < segments.length; end += 1) {
    if (matchesAt(pattern, segments.slice(0, end))) return true;
  }
  return false;
}
