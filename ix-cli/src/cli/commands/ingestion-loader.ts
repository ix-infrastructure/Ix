import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type IngestionModule = {
  parseFile: (filePath: string, source: string) => any;
  resolveEdges: (results: any[], stats?: any, globalIndex?: any) => any[];
  isGrammarSupported: (filePath: string) => boolean;
  buildGlobalResolutionIndex: (filePaths: string[], sources?: Map<string, string>, preParsed?: Map<string, any>) => any;
};

type PatchBuilderModule = {
  buildPatch: (parsed: any, hash: string, workspaceId: string, previousSourceHash?: string) => any;
  buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, resolvedEdges: any[], previousSourceHash?: string) => any;
  buildDeletionPatch: (filePath: string, previousSourceHash: string, deletionToken: string, workspaceId: string, ops: any[], multiRepo?: any) => any;
  sourcePatchIdCandidates: (filePath: string, sourceHash: string, workspaceId: string) => string[];
  fileNodeId: (workspaceId: string, filePath: string) => string;
  symbolNodeId: (workspaceId: string, filePath: string, qualifiedKey: string) => string;
};

type LanguagesModule = {
  languageFromPath: (filePath: string) => string | null;
};

const importViaFunction = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<any>;

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
    // Matched on `code`, not on the message. Node raises
    // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING and ..._FLAG here, and the
    // previous test was a substring of the English text -- reword that upstream
    // and this guard silently stops matching: the harness goes red with the
    // original vm error and a real vm-hosted consumer regresses to unloadable,
    // with nothing pointing at the guard. The message check is kept only as a
    // fallback for an error that arrives without a code.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const isVmCallbackMissing = code
      ? code.startsWith("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING")
      : /dynamic import callback/i.test(String(err));
    if (!isVmCallbackMissing) throw err;
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

export async function loadWatchIngestionModules(): Promise<[
  IngestionModule,
  PatchBuilderModule,
]> {
  return Promise.all([
    importModule(resolveIngestionModule("../../../../core-ingestion/dist/index.js")),
    importModule(resolveIngestionModule("../../../../core-ingestion/dist/patch-builder.js")),
  ]);
}
