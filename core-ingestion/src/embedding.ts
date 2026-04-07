/**
 * EmbeddingService — compute vector embeddings at ingestion time.
 *
 * Calls the Voyage AI API (or compatible endpoint) to embed text and images
 * into a shared vector space for semantic search.
 *
 * Environment variables:
 *   VOYAGE_API_KEY       — API key (required to enable embedding)
 *   VOYAGE_API_BASE_URL  — API base URL (default: https://api.voyageai.com/v1)
 *   VOYAGE_MODEL         — Model name (default: voyage-3)
 *
 * When VOYAGE_API_KEY is not set, all methods return null and ingestion
 * proceeds without embeddings — purely additive, no breakage.
 */

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimension: number;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export class EmbeddingService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? 'https://api.voyageai.com/v1';
    this.model = model ?? 'voyage-3';
  }

  /**
   * Create an EmbeddingService from environment variables.
   * Returns null if VOYAGE_API_KEY is not set.
   */
  static fromEnv(): EmbeddingService | null {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) return null;
    return new EmbeddingService(
      apiKey,
      process.env.VOYAGE_API_BASE_URL,
      process.env.VOYAGE_MODEL,
    );
  }

  /** Embed a single text for storage (document input type). */
  async embedText(text: string): Promise<EmbeddingResult | null> {
    const results = await this.embedBatch([text], 'document');
    return results?.[0] ?? null;
  }

  /** Embed a query for retrieval (query input type — asymmetric). */
  async embedQuery(query: string): Promise<EmbeddingResult | null> {
    const results = await this.embedBatch([query], 'query');
    return results?.[0] ?? null;
  }

  /**
   * Embed a batch of texts. Returns one EmbeddingResult per input.
   * Batching reduces API calls — Voyage supports up to 128 inputs per request.
   */
  async embedBatch(
    inputs: string[],
    inputType: 'document' | 'query' = 'document',
  ): Promise<EmbeddingResult[] | null> {
    if (inputs.length === 0) return [];

    // Voyage API has a batch limit of 128 inputs
    const batchSize = 128;
    const allResults: EmbeddingResult[] = [];

    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const response = await this.callApi(batch, inputType);
      if (!response) return null;

      for (const item of response.data) {
        allResults.push({
          embedding: item.embedding,
          model: response.model,
          dimension: item.embedding.length,
        });
      }
    }

    return allResults;
  }

  private async callApi(
    inputs: string[],
    inputType: string,
  ): Promise<VoyageResponse | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: inputs,
          model: this.model,
          input_type: inputType,
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        process.stderr.write(
          `[ix-embedding] Voyage API error ${resp.status}: ${errorText.slice(0, 200)}\n`,
        );
        return null;
      }

      return (await resp.json()) as VoyageResponse;
    } catch (err) {
      process.stderr.write(
        `[ix-embedding] Failed to call embedding API: ${err}\n`,
      );
      return null;
    }
  }
}

/**
 * Compute the text content to embed for a given node.
 * Different node kinds get different embedding inputs for optimal retrieval.
 */
export function embeddingContentForNode(
  kind: string,
  name: string,
  attrs: Record<string, unknown>,
): string {
  switch (kind) {
    case 'function':
    case 'method':
      // Include signature + docstring if available
      return [name, attrs.signature, attrs.docstring, attrs.content]
        .filter(Boolean)
        .join('\n');

    case 'class':
    case 'interface':
    case 'trait':
    case 'object':
      return [name, attrs.docstring, attrs.content]
        .filter(Boolean)
        .join('\n');

    case 'chunk':
      return (attrs.content as string) ?? name;

    case 'paper':
      return [attrs.title, attrs.abstract, name]
        .filter(Boolean)
        .join('\n');

    case 'tweet':
      return [name, attrs.content, attrs.author]
        .filter(Boolean)
        .join(' — ');

    case 'chat_message':
      return [attrs.author, attrs.content]
        .filter(Boolean)
        .join(': ');

    case 'concept':
      return [name, attrs.description, attrs.content]
        .filter(Boolean)
        .join('\n');

    case 'decision':
      return [attrs.title, attrs.rationale]
        .filter(Boolean)
        .join('\n');

    case 'intent':
      return (attrs.statement as string) ?? name;

    case 'doc':
    case 'webpage':
      return [attrs.title, attrs.content, name]
        .filter(Boolean)
        .join('\n');

    default:
      // For file, module, config, etc. — use name + any content
      return [name, attrs.content].filter(Boolean).join('\n');
  }
}
