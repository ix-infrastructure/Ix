// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which language grammars did not load, and what that cost a run (#967).
 *
 * Fourteen grammars are optional dependencies of core-ingestion, loaded through
 * a quiet try/catch so a platform without a prebuild does not flood every parse
 * worker's stderr. Their files are still discovered and dispatched, and come
 * back unparsed on every run. Before this, the only trace was a count under
 * "skipped" with no language named. These helpers turn core-ingestion's
 * `grammarStatus()` into the lines `ix map`, `ix ingest` and `ix doctor` print.
 */

/** What core-ingestion's `grammarStatus()` returns per grammar. */
export interface GrammarStatus {
  language: string;
  loaded: boolean;
  package?: string;
  reason?: string;
}

/** A language whose grammar did not load, and how many of this run's files it covers. */
export interface UnavailableGrammarFiles {
  language: string;
  files: number;
  package?: string;
  reason?: string;
}

/**
 * Count the discovered files that belong to a language whose grammar did not
 * load. Languages with no such files are left out: a missing grammar the repo
 * never needs is not this run's problem. Sorted by file count, then language.
 */
export function unavailableGrammarFiles(
  filePaths: readonly string[],
  statuses: readonly GrammarStatus[],
  languageFromPath: (filePath: string) => string | null,
): UnavailableGrammarFiles[] {
  const missing = new Map(statuses.filter((s) => !s.loaded).map((s) => [s.language, s]));
  if (missing.size === 0) return [];
  const counts = new Map<string, number>();
  for (const fp of filePaths) {
    // A .tsx file reports `typescript`, whose grammar is statically imported
    // and always loaded, so it can never land here by mistake.
    const language = languageFromPath(fp);
    if (language !== null && missing.has(language)) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, files]) => {
      const s = missing.get(language)!;
      return {
        language,
        files,
        ...(s.package ? { package: s.package } : {}),
        ...(s.reason ? { reason: s.reason } : {}),
      };
    })
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

/**
 * One line per language, e.g.
 * `kotlin: 12 files not parsed — grammar tree-sitter-kotlin did not load (Cannot find module 'tree-sitter-kotlin')`.
 * Plain text: the caller colours it.
 */
export function describeUnavailableGrammars(unavailable: readonly UnavailableGrammarFiles[]): string[] {
  return unavailable.map((u) => {
    const files = `${u.files} ${u.files === 1 ? "file" : "files"}`;
    const grammar = u.package ? `grammar ${u.package}` : "grammar";
    const reason = u.reason ? ` (${u.reason})` : "";
    return `${u.language}: ${files} not parsed — ${grammar} did not load${reason}`;
  });
}

/**
 * Read `grammarStatus` off a loaded core-ingestion module. A build that
 * predates it has no such export, and a status read must never be the reason
 * an ingest fails, so both cases answer "nothing known".
 */
export function readGrammarStatus(mod: { grammarStatus?: () => GrammarStatus[] }): GrammarStatus[] {
  try {
    return typeof mod.grammarStatus === "function" ? mod.grammarStatus() : [];
  } catch {
    return [];
  }
}
