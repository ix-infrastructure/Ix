/**
 * Embedding enrichment — adds vector embeddings to UpsertNode ops in a patch.
 *
 * This is a post-processing step that runs after buildPatch/buildPatchWithResolution.
 * It reads node content from the ops, batches embedding computation, and injects
 * the embedding into each node's attrs. Non-invasive: if the EmbeddingService
 * is unavailable, the patch is returned unchanged.
 */

import type { GraphPatchPayload, PatchOp } from './types.js';
import { EmbeddingService, embeddingContentForNode } from './embedding.js';

/**
 * Enrich a patch payload by computing embeddings for all UpsertNode ops.
 * The embedding is added to each node's attrs as:
 *   { embedding: number[], embedding_model: string, embedding_dim: number, embedding_updated_at: string }
 *
 * Returns the patch unchanged if:
 *   - embeddingService is null (VOYAGE_API_KEY not set)
 *   - there are no UpsertNode ops
 *   - the API call fails (degrades gracefully)
 */
export async function enrichPatchWithEmbeddings(
  patch: GraphPatchPayload,
  embeddingService: EmbeddingService | null,
): Promise<GraphPatchPayload> {
  if (!embeddingService) return patch;

  // Collect UpsertNode ops and their indices
  const nodeOps: Array<{ index: number; op: PatchOp }> = [];
  for (let i = 0; i < patch.ops.length; i++) {
    if (patch.ops[i].type === 'UpsertNode') {
      nodeOps.push({ index: i, op: patch.ops[i] });
    }
  }

  if (nodeOps.length === 0) return patch;

  // Build embedding input text for each node
  const texts = nodeOps.map(({ op }) => {
    const kind = op.kind as string;
    const name = op.name as string;
    const attrs = (op.attrs as Record<string, unknown>) ?? {};
    return embeddingContentForNode(kind, name, attrs);
  });

  // Filter out empty texts and track which indices to skip
  const nonEmptyIndices: number[] = [];
  const nonEmptyTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim().length > 0) {
      nonEmptyIndices.push(i);
      nonEmptyTexts.push(texts[i]);
    }
  }

  if (nonEmptyTexts.length === 0) return patch;

  // Batch embed all node content
  const results = await embeddingService.embedBatch(nonEmptyTexts);
  if (!results) return patch; // API failure — return patch unchanged

  // Inject embeddings into the original ops
  const updatedOps = [...patch.ops];
  const now = new Date().toISOString();

  for (let i = 0; i < nonEmptyIndices.length; i++) {
    const nodeOpIndex = nodeOps[nonEmptyIndices[i]].index;
    const originalOp = updatedOps[nodeOpIndex];
    const embeddingResult = results[i];

    updatedOps[nodeOpIndex] = {
      ...originalOp,
      attrs: {
        ...(originalOp.attrs as Record<string, unknown>),
        embedding: embeddingResult.embedding,
        embedding_model: embeddingResult.model,
        embedding_dim: embeddingResult.dimension,
        embedding_updated_at: now,
      },
    };
  }

  return { ...patch, ops: updatedOps };
}
