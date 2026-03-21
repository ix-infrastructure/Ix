import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type IngestionModule = {
  parseFile: (filePath: string, source: string) => any;
  resolveEdges: (results: any[]) => any[];
  isGrammarSupported: (filePath: string) => boolean;
};

type PatchBuilderModule = {
  buildPatch: (parsed: any, hash: string, previousSourceHash?: string) => any;
  buildPatchWithResolution: (parsed: any, hash: string, resolvedEdges: any[], previousSourceHash?: string) => any;
};

type LanguagesModule = {
  languageFromPath: (filePath: string) => string | null;
};

const importModule = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<any>;

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
