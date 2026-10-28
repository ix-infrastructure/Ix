// Copyright 2026 Ix Infrastructure Inc.

import * as crypto from 'node:crypto';

import type { SupportedLanguages } from './languages.js';

/**
 * Everything `resolveEdges` needs to know about a file when it is the TARGET
 * of a resolution rather than the file being resolved: what it defines, what
 * it exports, what it imports. Small enough to keep for a whole repository, so
 * a batch of changed files can be resolved against all the others without
 * parsing them (IN-09), and later persisted beside the ingest baseline (IN-10).
 *
 * Built by `summarizeParseResult` in `index.ts`. A batch file's summary and the
 * one in the index for the same content are identical, which is what makes
 * resolution independent of how the files are batched.
 */
export interface FileSummary {
  filePath: string;
  language: SupportedLanguages;
  /** Entities, file node included -- only the count is used (Go package anchors). */
  entityCount: number;
  /** `[name, qualifiedKey]` per entity other than the file and module nodes, in source order. */
  qkeys: Array<[string, string]>;
  /** `[public, local]` export names (JS/TS), when the file has any. */
  exportPublicNames?: Array<[string, string]>;
  /** The file's IMPORTS relationships, as the import resolver reads them. */
  imports: Array<{ dstName: string; importRaw?: string; importVia?: string; importAliased?: boolean }>;
  /** `[fqcn, typeName]` for unambiguous PHP types. */
  phpTypes?: Array<[string, string]>;
  /** Receiver inference facts needed across incremental batches. */
  receiverFactories?: Array<[string, string]>;
  receiverHeritage?: Array<[string, string]>;
  receiverPackage?: string;
  importAliases?: Record<string, string>;
  /** Sorted unique names this file calls, references or extends (for IN-11). */
  refs: string[];
  /** Hash of what other files can resolve to here: qualified keys, exports, PHP types. */
  sig: string;
}

/** The part of a summary other files depend on, hashed. */
export function summarySignature(s: Pick<FileSummary, 'qkeys' | 'exportPublicNames' | 'phpTypes' | 'receiverFactories' | 'receiverHeritage' | 'receiverPackage'> & Partial<Pick<FileSummary, 'imports' | 'importAliases'>>): string {
  const parts: unknown[] = [
    [...s.qkeys].map(([n, q]) => `${n}\0${q}`).sort(),
    [...(s.exportPublicNames ?? [])].map(([p, l]) => `${p}\0${l}`).sort(),
    [...(s.phpTypes ?? [])].map(([f, t]) => `${f}\0${t}`).sort(),
  ];
  // Receiver facts only when present, so other files keep their signature.
  if (s.receiverFactories?.length || s.receiverHeritage?.length || s.receiverPackage) {
    parts.push(
      // A factory's return type resolves through this file's imports (and Go aliases).
      [...(s.receiverFactories ?? [])].map(([f, t]) => `${f}\0${t}\0${heritageImportsKey(s.imports, s.importAliases)}`).sort(),
      // A superclass resolves through this file's imports.
      [...(s.receiverHeritage ?? [])].map(([f, t]) => `${f}\0${t}\0${heritageImportsKey(s.imports)}`).sort(),
      s.receiverPackage ?? '',
    );
  }
  const canonical = JSON.stringify(parts);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * The imports a Scala superclass or a factory's return type resolves through,
 * as one key. Any import can pick the type (wildcards included), so all of
 * them count, and so do Go import aliases when given.
 */
export function heritageImportsKey(imports: Array<{ dstName: string }> | undefined, aliases?: Record<string, string>): string {
  const key = [...new Set((imports ?? []).map(i => i.dstName))].sort().join('\0');
  const named = Object.entries(aliases ?? {}).map(([a, m]) => `${a}=${m}`).sort().join('\0');
  return named ? `${key}\0\0${named}` : key;
}
