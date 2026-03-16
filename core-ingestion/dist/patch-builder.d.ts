import type { GraphPatchPayload } from './types.js';
import type { FileParseResult, ResolvedCallEdge } from './index.js';
export declare function buildPatch(result: FileParseResult, sourceHash: string, previousSourceHash?: string): GraphPatchPayload;
export declare function buildPatchWithResolution(result: FileParseResult, sourceHash: string, resolvedEdges: ResolvedCallEdge[], previousSourceHash?: string): GraphPatchPayload;
