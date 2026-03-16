import { SupportedLanguages } from './languages.js';
export interface ParsedEntity {
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    language: string;
    /** Direct enclosing class/interface/trait, if any (undefined for file-level entities). */
    container?: string;
}
export interface ParsedRelationship {
    srcName: string;
    dstName: string;
    predicate: string;
}
export interface FileParseResult {
    filePath: string;
    language: SupportedLanguages;
    entities: ParsedEntity[];
    relationships: ParsedRelationship[];
}
/** Returns true if a grammar is installed for the given file's language. */
export declare function isGrammarSupported(filePath: string): boolean;
export declare function parseFile(filePath: string, source: string): FileParseResult | null;
export interface ResolvedCallEdge {
    callerFilePath: string;
    callerName: string;
    calleeFilePath: string;
    calleeName: string;
    calleeQualifiedKey: string;
    confidence: number;
}
/**
 * Resolves CALLS relationships to their cross-file targets by building a
 * symbol table and import map over the full batch of parsed files.
 *
 * Tiers (in priority order):
 *   0.9 — import-scoped: callee is in a file the caller explicitly imports
 *   0.5 — global fallback: callee exists in exactly one other file (unambiguous)
 *
 * Same-file calls (tier 0.95) are already handled correctly by buildPatch and
 * are not emitted here.
 *
 * Import resolution handles:
 *   - Stem-based:      './payments'     → 'payments.ts'
 *   - Path-aliased:    '@/lib/payments' → 'payments.ts'  (last segment)
 *   - Directory index: './services'     → 'services/index.ts'
 *   - Bare aliases:    '@components'    → 'components.ts' (strip leading non-word chars)
 *                      '~lib'           → 'lib.ts'
 *   - External bare:   'react'          → unresolved (no match in batch)
 *
 * Qualified-key resolution:
 *   - Module-level function: calleeQualifiedKey === calleeName
 *   - Unambiguous class method: calleeQualifiedKey === 'ClassName.method'
 *   - Ambiguous (two classes define same method name): edge not emitted
 */
export declare function resolveCallEdges(results: FileParseResult[]): ResolvedCallEdge[];
