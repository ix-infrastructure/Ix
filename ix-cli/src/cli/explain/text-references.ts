// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * Files a context target names in its text, and files whose text names it.
 *
 * Some links between files are never edges in the graph, because nothing
 * imports anything. On ix-bench, three expected files were unreachable by any
 * walk for exactly that reason:
 *
 *  - `ingestion-loader.ts` loads the parser registry through a string,
 *    `"../../../../core-ingestion/dist/languages.js"`, which names the build
 *    output of `core-ingestion/src/languages.ts`;
 *  - `supported-extensions.ts` says, in a comment, that it "MUST stay in sync
 *    with core-ingestion's EXT_MAP (languages.ts)";
 *  - the parity test reads `supported-extensions.ts` as text, by path, rather
 *    than importing it.
 *
 * So this reads the target and the files it imports for path-like tokens
 * that name a repository file (forward), and searches the repository for
 * files that name the target or its imports outside an import statement
 * (reverse). Import lines are skipped on both sides: the graph already has
 * those, and counting them again would turn every importer into a "mention".
 *
 * Precision comes from resolution, not from the pattern. A token counts only
 * when it resolves to exactly one tracked file: relative to the file it is in,
 * as a repository path, as a unique path suffix, or as a basename no other
 * file shares. A build path maps back to its source (`dist/` -> `src/`,
 * `.js` -> `.ts`). A name that half the repository mentions is not a link.
 */

export interface TextReference {
  /** Repository-relative path of the file referred to or referring. */
  path: string;
  /** Higher is stronger. Comparable within one bundle. */
  score: number;
  /** Why, for the evidence row: `named in supported-extensions.ts`. */
  reason: string;
}

export interface TextSource {
  /** Repository-relative path of a file whose text is read. */
  path: string;
  /** The target itself, or one of the files it imports. */
  role: "target" | "import";
}

/** How the repository is read. Injected so the logic is testable without one. */
export interface RepoAccess {
  /** Every tracked file, repository-relative. */
  files(): string[];
  /** A tracked file's text, or undefined when unreadable or too large. */
  read(path: string): string | undefined;
  /** Files containing `needle` literally, with the matching lines. */
  grep(needle: string): Array<{ path: string; line: string }>;
}

/** Text references a bundle carries. */
export const MAX_TEXT_REFERENCES = 3;
/** A name mentioned outside imports by more files than this is not a link. */
const MAX_MENTIONERS = 6;
/** Files larger than this are not scanned for names. */
const MAX_SCAN_BYTES = 256 * 1024;

const WEIGHT = { forwardTarget: 1, reverseTarget: 0.8, forwardImport: 0.6, reverseImport: 0.5 };

// A path-like token ending in a source or config extension: `./x.ts`,
// `../../a/dist/b.js`, `core-ingestion/src/languages.ts`, `languages.ts`.
const PATH_TOKEN =
  /(?<![\w./-])((?:\.{1,2}\/)*(?:[\w@-][\w.@-]*\/)*[\w-][\w.-]*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|rb|json|ya?ml|toml|sh))(?![\w/])/g;

/**
 * `import … from`, `export … from`, `require(` -- the graph has these. A
 * dynamic `import("…")` is deliberately not here: its argument is often
 * computed or a build path, which is exactly the link the graph lacks.
 */
const IMPORT_LINE = /^\s*(?:import\b(?!\s*\()|export\b[^=]*\bfrom\b)|\brequire\s*\(/;

/** Files whose mention of a name is a reference: code, not prose. */
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|scala|rb|sh)$/;

export function collectTextReferences(
  repo: RepoAccess,
  sources: TextSource[],
  exclude: ReadonlySet<string>,
  limit = MAX_TEXT_REFERENCES,
): TextReference[] {
  const files = repo.files();
  const tracked = new Set(files);
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    const base = posix.basename(file);
    byBasename.set(base, [...(byBasename.get(base) ?? []), file]);
  }
  const sourcePaths = new Set(sources.map((s) => s.path));
  const found = new Map<string, TextReference>();
  const credit = (path: string, score: number, reason: string) => {
    if (exclude.has(path) || sourcePaths.has(path)) return;
    const prior = found.get(path);
    if (!prior || score > prior.score) found.set(path, { path, score, reason });
  };

  for (const source of sources) {
    const text = repo.read(source.path);
    if (text === undefined) continue;
    const name = posix.basename(source.path);

    // Forward: what this file names.
    const named = new Set<string>();
    for (const line of text.split("\n")) {
      if (IMPORT_LINE.test(line)) continue;
      for (const match of line.matchAll(PATH_TOKEN)) {
        const resolved = resolveToken(match[1], source.path, tracked, byBasename);
        if (resolved && resolved !== source.path) named.add(resolved);
      }
    }
    const forward = source.role === "target" ? WEIGHT.forwardTarget : WEIGHT.forwardImport;
    for (const path of named) credit(path, forward, `named in ${name}`);

    // Reverse: who names this file. Only a basename no other tracked file
    // shares can be attributed from a bare mention.
    if ((byBasename.get(name) ?? []).length !== 1) continue;
    const mentioners = new Set<string>();
    for (const hit of repo.grep(name)) {
      if (hit.path === source.path || !tracked.has(hit.path) || !CODE_FILE.test(hit.path)) continue;
      if (IMPORT_LINE.test(hit.line)) continue;
      mentioners.add(hit.path);
    }
    if (mentioners.size === 0 || mentioners.size > MAX_MENTIONERS) continue;
    const reverse = (source.role === "target" ? WEIGHT.reverseTarget : WEIGHT.reverseImport) / mentioners.size;
    for (const path of mentioners) credit(path, reverse, `names ${name} in its text`);
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}

/**
 * The one tracked file a token names, or undefined.
 *
 * Tried in order: relative to the file it appears in, as a repository path,
 * as a unique path suffix, as a unique basename. Each form is also tried as a
 * build path mapped back to source.
 */
export function resolveToken(
  token: string,
  from: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
): string | undefined {
  const exists = (candidate: string) => sourceForms(candidate).find((f) => tracked.has(f));

  if (token.startsWith("./") || token.startsWith("../")) {
    const joined = posix.normalize(posix.join(posix.dirname(from), token));
    return joined.startsWith("..") ? undefined : exists(joined);
  }
  if (token.includes("/")) {
    const direct = exists(token);
    if (direct) return direct;
    const suffix = sourceForms(token);
    const hits = [...tracked].filter((f) => suffix.some((s) => f.endsWith(`/${s}`)));
    return hits.length === 1 ? hits[0] : undefined;
  }
  const candidates = new Set(sourceForms(token).flatMap((f) => byBasename.get(f) ?? []));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** A path and the source paths its build output could have come from. */
const BUILD_EXTENSIONS: Array<[RegExp, string[]]> = [
  [/\.js$/, [".ts", ".tsx", ".js"]],
  [/\.mjs$/, [".mts", ".mjs"]],
  [/\.cjs$/, [".cts", ".cjs"]],
  [/\.jsx$/, [".tsx", ".jsx"]],
];

function sourceForms(path: string): string[] {
  const bases = new Set([path]);
  if (/(^|\/)dist\//.test(path)) bases.add(path.replace(/(^|\/)dist\//, "$1src/"));
  const out = new Set<string>();
  for (const base of bases) {
    out.add(base);
    for (const [pattern, exts] of BUILD_EXTENSIONS) {
      if (pattern.test(base)) for (const ext of exts) out.add(base.replace(pattern, ext));
    }
  }
  return [...out];
}

/**
 * The repository as git sees it, rooted at `root`. Outside a git checkout
 * there is no file list to resolve against, and this returns undefined: the
 * signal is skipped rather than guessed.
 */
export function gitRepoAccess(root: string): RepoAccess | undefined {
  let listing: string[];
  try {
    listing = execFileSync("git", ["ls-files", "-z"], {
      cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
  return {
    files: () => listing,
    read: (path) => {
      const abs = join(root, path);
      try {
        if (!existsSync(abs) || statSync(abs).size > MAX_SCAN_BYTES) return undefined;
        return readFileSync(abs, "utf-8");
      } catch {
        return undefined;
      }
    },
    grep: (needle) => {
      try {
        const out = execFileSync("git", ["grep", "-n", "-I", "-F", "-e", needle], {
          cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
        });
        return out.split("\n").filter(Boolean).map((row) => {
          const first = row.indexOf(":");
          const second = row.indexOf(":", first + 1);
          return { path: row.slice(0, first), line: row.slice(second + 1) };
        });
      } catch {
        return []; // exit 1 is "no match"
      }
    },
  };
}
