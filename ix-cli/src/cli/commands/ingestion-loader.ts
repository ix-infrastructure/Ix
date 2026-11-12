// Copyright 2026 Ix Infrastructure Inc.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readGrammarStatus, type GrammarStatus } from "../grammar-status.js";
import type { StoredSummary } from "../ingest-symbols.js";

type IngestionModule = {
  parseFile: (filePath: string, source: string) => any;
  resolveEdges: (results: any[], stats?: any, globalIndex?: any) => any[];
  isGrammarSupported: (filePath: string) => boolean;
  /** Absent from a core-ingestion build older than #967; read it through `readGrammarStatus`. */
  grammarStatus?: () => GrammarStatus[];
  buildGlobalResolutionIndex: (filePaths: string[], summaries?: Map<string, any>) => any;
  summarizeParseResult: (parsed: any) => { filePath: string; [key: string]: unknown };
};

type PatchBuilderModule = {
  buildPatch: (parsed: any, hash: string, workspaceId: string, previousSourceHash?: string) => any;
  buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, resolvedEdges: any[], previousSourceHash?: string) => any;
  buildDeletionPatch: (filePath: string, previousSourceHash: string, deletionToken: string, workspaceId: string, ops: any[], multiRepo?: any) => any;
  sourcePatchIdCandidates: (filePath: string, sourceHash: string, workspaceId: string) => string[];
  fileNodeId: (workspaceId: string, filePath: string) => string;
  symbolNodeId: (workspaceId: string, filePath: string, qualifiedKey: string) => string;
  extractorName: () => string;
  /** Earlier extractor names, newest first: `sourcePatchIdCandidates` order after the current one. */
  PREVIOUS_EXTRACTORS?: readonly string[];
};

/**
 * core-ingestion's `symbol-index.js`: what a stored summary means for other
 * files (IN-11). It loads no grammar, so the dependents step can use it
 * without loading the parser.
 */
type SymbolIndexModule = {
  changedNames: (before: StoredSummary | undefined, after: StoredSummary | undefined) => Set<string>;
  importsChanged: (before: StoredSummary | undefined, after: StoredSummary | undefined) => boolean;
  findDependents: (
    table: ReadonlyMap<string, { summary: StoredSummary }>,
    names: ReadonlySet<string>,
    paths: Iterable<string>,
    exclude: ReadonlySet<string>,
    packageEntries?: Iterable<string>,
  ) => string[];
};

type LanguagesModule = {
  languageFromPath: (filePath: string) => string | null;
};

const importViaFunction = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<any>;

/**
 * Is this "this host cannot do dynamic import", as opposed to any other error?
 *
 * Exported for its test. The shapes it has to accept are not guessable, which
 * is why that test derives them from a real failure rather than writing plausible
 * ones by hand.
 */
export function isVmDynamicImportUnavailable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return (
    (typeof code === "string" && code.startsWith("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING")) ||
    /dynamic import callback/i.test(String(err))
  );
}

/**
 * Load a built `core-ingestion` module by absolute file URL.
 *
 * The `new Function` indirection is the primary path and stays first: it keeps
 * a specifier pointing four levels outside this package away from anything that
 * would try to resolve or bundle it.
 *
 * It cannot run everywhere, though. A host that evaluates this module inside a
 * `vm` context with no `importModuleDynamically` hook -- vitest's vite-node,
 * notably -- throws `A dynamic import callback was not specified` from the
 * indirection itself, not from the module being loaded. That made `ingestFiles`
 * impossible to drive from a test, which is why the commit path had integration
 * coverage of exactly none while two PRs reworked it.
 *
 * So: fall back to a direct `import()`, and only for that one failure. A
 * genuine module-not-found still propagates, rather than being retried and
 * reported twice.
 */
const importModule = async (specifier: string): Promise<any> => {
  try {
    return await importViaFunction(specifier);
  } catch (err) {
    // EITHER signal, never one excluding the other. Node raises
    // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING (and a ..._FLAG variant) with a
    // matching message, and the code is the stabler of the two -- but an
    // earlier revision wrote this as a ternary, so the message test became
    // reachable only when `code` was absent. That is NARROWER than the plain
    // message match it replaced, and it breaks on the host this fallback exists
    // for: Vite's module runner rethrows the vm failure with its own
    // `code: 'ERR_LOAD_URL'` while preserving the message, so the wrapped error
    // has a code, fails the prefix test, never reaches the message test, and
    // `ingestFiles` becomes unloadable under vite-node.
    //
    // `typeof code === "string"` because `code` is only typed as a string.
    // Numeric codes are common in the wild (libuv, zlib, OpenSSL), and
    // `.startsWith` on one throws a TypeError from inside this catch --
    // replacing the real load failure with an unrelated type error and
    // discarding the original, which is the exact failure the rest of this
    // block exists to prevent.
    if (!isVmDynamicImportUnavailable(err)) throw err;
    try {
      // The ignore pragmas are load-bearing, not decoration. A bare
      // `import(variable)` is exactly the static-analysis surface the
      // `new Function` indirection above exists to avoid: bundlers analyse it
      // whichever branch runs, and webpack/ncc turn it into a critical-
      // dependency context module over the whole directory. A second
      // `new Function` is not an option -- that is the path that just failed.
      return await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
    } catch (fallbackErr) {
      // Both paths failed, so report both. Discarding the vm error here meant a
      // host where neither works blamed module resolution for what was really
      // the missing import callback.
      throw new Error(
        `cannot load ${specifier}: dynamic import is unavailable in this host ` +
          `(${String(err)}), and the direct import also failed (${String(fallbackErr)})`,
        { cause: fallbackErr },
      );
    }
  }
};

const currentDir = dirname(fileURLToPath(import.meta.url));

function resolveIngestionModule(relativePath: string): string {
  return pathToFileURL(resolve(currentDir, relativePath)).href;
}

export async function loadIngestionModules(): Promise<[
  IngestionModule,
  PatchBuilderModule,
  LanguagesModule,
]> {
  return Promise.all([
    importModule(resolveIngestionModule("../../../../core-ingestion/dist/index.js")),
    importModule(resolveIngestionModule("../../../../core-ingestion/dist/patch-builder.js")),
    importModule(resolveIngestionModule("../../../../core-ingestion/dist/languages.js")),
  ]);
}

/** core-ingestion's dependents rules (`symbol-index.ts`), without the parser. */
export async function loadSymbolIndex(): Promise<SymbolIndexModule> {
  return importModule(resolveIngestionModule("../../../../core-ingestion/dist/symbol-index.js"));
}

/**
 * Which tree-sitter grammars loaded in this install (#967), for `ix doctor`.
 *
 * Loads only the parser entry point, and is deliberately not
 * `loadIngestionModules`: reading grammar status parses nothing, and doctor's
 * tests count that function's calls to prove the re-parse check stays idle on
 * an unhealthy backend.
 */
export async function loadGrammarStatus(): Promise<GrammarStatus[]> {
  return readGrammarStatus(await importModule(resolveIngestionModule("../../../../core-ingestion/dist/index.js")));
}
