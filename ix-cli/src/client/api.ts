import type {
  CommitResult,
  IngestResult,
  StructuredContext,
  GraphNode,
  HealthResponse,
  PatchSummary,
} from "./types.js";

export class IxClient {
  constructor(private endpoint: string = "http://localhost:8090") {}

  async query(
    question: string,
    opts?: { asOfRev?: number; depth?: string }
  ): Promise<StructuredContext> {
    console.log("CLI depth:", opts?.depth);
    return this.post("/v1/context", { query: question, ...opts });
  }

  async ingest(path: string, recursive?: boolean): Promise<IngestResult> {
    return this.post("/v1/ingest", { path, recursive });
  }

  async decide(
    title: string,
    rationale: string,
    opts?: { intentId?: string }
  ): Promise<{ status: string; nodeId: string; rev: number }> {
    return this.post("/v1/decide", { title, rationale, ...opts });
  }

  async search(
    term: string,
    opts?: { limit?: number; kind?: string; language?: string; asOfRev?: number }
  ): Promise<GraphNode[]> {
    return this.post("/v1/search", {
      term,
      limit: opts?.limit,
      kind: opts?.kind,
      language: opts?.language,
      asOfRev: opts?.asOfRev,
    });
  }

  async listDecisions(opts?: { limit?: number; topic?: string }): Promise<GraphNode[]> {
    return this.post("/v1/decisions", { limit: opts?.limit, topic: opts?.topic });
  }

  async resolvePrefix(prefix: string): Promise<string> {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(prefix)) return prefix;

    const result = await this.get<{ id?: string; error?: string; matches?: string[] }>(
      `/v1/resolve-prefix/${encodeURIComponent(prefix)}`
    );
    if (result.id) return result.id;
    if (result.error === "ambiguous") {
      throw new Error(`Ambiguous prefix "${prefix}" — matches: ${result.matches?.join(", ")}`);
    }
    throw new Error(`No entity found for prefix: ${prefix}`);
  }

  async entity(id: string): Promise<{
    node: GraphNode;
    claims: unknown[];
    edges: unknown[];
  }> {
    return this.get(`/v1/entity/${id}`);
  }

  async expand(
    id: string,
    opts?: { direction?: string; predicates?: string[]; hops?: number }
  ): Promise<{ nodes: any[]; edges: any[] }> {
    return this.post("/v1/expand", {
      nodeId: id,
      direction: opts?.direction ?? "both",
      predicates: opts?.predicates,
      hops: opts?.hops ?? 1,
    });
  }

  async listTruth(): Promise<GraphNode[]> {
    return this.get("/v1/truth");
  }

  async createTruth(
    statement: string,
    parentIntent?: string
  ): Promise<{ status: string; nodeId: string; rev: number }> {
    return this.post("/v1/truth", { statement, parentIntent });
  }

  async listPatches(): Promise<PatchSummary[]> {
    return this.get("/v1/patches");
  }

  async getPatch(id: string): Promise<unknown> {
    return this.get(`/v1/patches/${id}`);
  }

  async diff(
    fromRev: number,
    toRev: number,
    entityId?: string
  ): Promise<unknown> {
    return this.post("/v1/diff", { fromRev, toRev, entityId });
  }

  async conflicts(): Promise<unknown[]> {
    return this.get("/v1/conflicts");
  }

  async provenance(entityId: string): Promise<unknown> {
    return this.post(`/v1/provenance/${entityId}`, {});
  }

  async health(): Promise<HealthResponse> {
    return this.get("/v1/health");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.endpoint}${path}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  }
}
