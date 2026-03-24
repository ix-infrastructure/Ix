import { SupportedLanguages } from './languages.js';
import type { RoleClassification } from './role-classifier.js';
export interface ParsedEntity {
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    language: string;
    /** Direct enclosing class/interface/trait, if any (undefined for file-level entities). */
    container?: string;
}
/** A semantic code span extracted from the AST. The primary LLM retrieval unit. */
export interface ParsedChunk {
    /** Semantic name of the chunk (function/class/trait name), or null for file_body. */
    name: string | null;
    /** Chunk kind: "function" | "method" | "class" | "interface" | "trait" | "module_block" | "file_body" */
    chunkKind: string;
    lineStart: number;
    lineEnd: number;
    startByte: number;
    endByte: number;
    /** SHA-256 of the chunk source text for change detection and stable identity. */
    contentHash: string;
    language: string;
    /** Name of the directly enclosing class/trait/interface, if any. */
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
    chunks: ParsedChunk[];
    relationships: ParsedRelationship[];
    fileRole: RoleClassification;
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
/** Generalised form of ResolvedCallEdge that covers any cross-file edge predicate. */
export interface ResolvedEdge {
    srcFilePath: string;
    srcName: string;
    dstFilePath: string;
    dstName: string;
    dstQualifiedKey: string;
    predicate: string;
    confidence: number;
}
/**
 * Resolves CALLS and EXTENDS relationships to their cross-file targets by
 * building a symbol table and import map over the full batch of parsed files.
 *
 * Tiers (in priority order):
 *   0.9 — import-scoped: dst is in a file the src explicitly imports
 *   0.8 — transitive import-scoped: one re-export hop away
 *   0.5 — global fallback: dst exists in exactly one other file (unambiguous)
 *
 * Same-file edges are already handled correctly by buildPatch and are not
 * emitted here.
 *
 * Import resolution handles:
 *   - Stem-based:      './payments'     → 'payments.ts'
 *   - Path-aliased:    '@/lib/payments' → 'payments.ts'  (last segment)
 *   - Directory index: './services'     → 'services/index.ts'
 *   - Bare aliases:    '@components'    → 'components.ts' (strip leading non-word chars)
 *   - Dotted paths:    'ix.memory.model.Edge' → stem 'Edge' → 'Edge.scala'
 *                      (handles Scala/Java package imports where tree-sitter
 *                       emits each identifier separately)
 *
 * Qualified-key resolution:
 *   - Module-level function/class: dstQualifiedKey === dstName
 *   - Unambiguous class method: dstQualifiedKey === 'ClassName.method'
 *   - Ambiguous (two entities share the same plain name): edge not emitted
 */
/** Stats collected during resolution (exposed for debug instrumentation). */
export interface ResolveStats {
    importLookups: number;
    transitiveLookups: number;
    globalFallbacks: number;
    globalCandidateTotal: number;
    resolvedImport: number;
    resolvedTransitive: number;
    resolvedGlobal: number;
    resolvedQualifier: number;
    skippedSameFile: number;
    skippedAmbiguous: number;
}
export declare function resolveEdges(results: FileParseResult[]): ResolvedEdge[];
export declare function resolveEdges(results: FileParseResult[], statsOut: ResolveStats): ResolvedEdge[];
/** @deprecated Use resolveEdges instead. */
export declare function resolveCallEdges(results: FileParseResult[]): ResolvedCallEdge[];
