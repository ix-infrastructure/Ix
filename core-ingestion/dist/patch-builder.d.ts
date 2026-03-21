import type { GraphPatchPayload } from './types.js';
import type { FileParseResult, ResolvedEdge } from './index.js';
export declare function extractorName(): string;
/** Previous extractor versions — their patches are superseded when re-ingesting. */
export declare const PREVIOUS_EXTRACTORS: string[];
export declare function buildPatch(result: FileParseResult, sourceHash: string, previousSourceHash?: string): GraphPatchPayload;
export declare function buildPatchWithResolution(result: FileParseResult, sourceHash: string, resolvedEdges: ResolvedEdge[], previousSourceHash?: string): GraphPatchPayload;
