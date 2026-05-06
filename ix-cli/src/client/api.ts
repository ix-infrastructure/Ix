import type {
  CommitResult,
  IngestResult,
  StructuredContext,
  GraphNode,
  HealthResponse,
  PatchSummary,
  GraphPatchPayload,
  PatchCommitResult,
} from "./types.js";

export class IxClient {
  constructor(private endpoint: string = "http://localhost:8090") {}

  async query(
    question: string,
    opts?: { asOfRev?: number; depth?: string }
  ): Promise<StructuredContext> {
    return this.post("/v1/context", { query: question, ...opts });
  }

  async ingest(path: string, recursive?: boolean, force?: boolean): Promise<IngestResult> {
    const resp = await fetch(`${this.endpoint}/v1/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, recursive, force: force || undefined }),
      signal: AbortSignal.timeout(30 * 60 * 1000), // 30 minute timeout for large repos
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<IngestResult>;
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
    opts?: { limit?: number; kind?: string; language?: string; asOfRev?: number; nameOnly?: boolean }
  ): Promise<GraphNode[]> {
    return this.post("/v1/search", {
      term,
      limit: opts?.limit,
      kind: opts?.kind,
      language: opts?.language,
      asOfRev: opts?.asOfRev,
      nameOnly: opts?.nameOnly,
    });
  }

  async listByKind(
    kind: string,
    opts?: { limit?: number; scope?: string }
  ): Promise<GraphNode[]> {
    return this.post("/v1/list", {
      kind,
      limit: opts?.limit,
      scope: opts?.scope,
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

  async expandByName(
    name: string,
    opts?: { direction?: string; predicates?: string[]; kinds?: string[] }
  ): Promise<{ nodes: any[]; edges: any[] }> {
    return this.post("/v1/expand-by-name", {
      name,
      direction: opts?.direction ?? "both",
      predicates: opts?.predicates,
      kinds: opts?.kinds,
    });
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

  async listGoals(): Promise<GraphNode[]> {
    return this.get("/v1/truth");
  }

  async createGoal(
    statement: string,
    parentGoal?: string
  ): Promise<{ status: string; nodeId: string; rev: number }> {
    return this.post("/v1/truth", { statement, parentIntent: parentGoal });
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

  async listPatches(opts?: { limit?: number }): Promise<PatchSummary[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.get(`/v1/patches${qs ? `?${qs}` : ""}`);
  }

  async getPatch(id: string): Promise<unknown> {
    return this.get(`/v1/patches/${id}`);
  }

  async diff(
    fromRev: number,
    toRev: number,
    opts?: { entityId?: string; summary?: boolean; limit?: number }
  ): Promise<unknown> {
    return this.post("/v1/diff", {
      fromRev,
      toRev,
      entityId: opts?.entityId,
      summary: opts?.summary,
      limit: opts?.limit,
    });
  }

  async conflicts(): Promise<unknown[]> {
    return this.get("/v1/conflicts");
  }

  async provenance(entityId: string): Promise<unknown> {
    return this.post(`/v1/provenance/${entityId}`, {});
  }

  async commitPatch(patch: GraphPatchPayload): Promise<PatchCommitResult> {
    const resp = await fetch(`${this.endpoint}/v1/patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min — matches commitPatchBulk
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<PatchCommitResult>;
  }

  async hasIngestBaseline(): Promise<boolean> {
    const result = await this.get<{ exists: boolean }>('/v1/source-hashes/exists');
    return result.exists;
  }

  async commitPatchBatch(patches: GraphPatchPayload[]): Promise<PatchCommitResult[]> {
    return this.post("/v1/patches/batch", patches);
  }

  async getSourceHashes(filePaths: string[]): Promise<Map<string, string>> {
    const result = await this.post<Record<string, string>>('/v1/source-hashes', { uris: filePaths });
    return new Map(Object.entries(result));
  }

  async map(opts?: { full?: boolean }): Promise<any> {
    const resp = await fetch(`${this.endpoint}/v1/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts ?? {}),
      signal: AbortSignal.timeout(30 * 60 * 1000), // 30 minute timeout
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async commitPatchBulk(patches: GraphPatchPayload[]): Promise<PatchCommitResult> {
    const resp = await fetch(`${this.endpoint}/v1/patches/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patches }),
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min — prevents hang when k8s ingress closes idle connections
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<PatchCommitResult>;
  }

  async runSmells(opts?: {
    orphanMaxConnections?: number;
    godModuleChunks?: number;
    godModuleFan?: number;
    weakMaxNeighbors?: number;
  }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.orphanMaxConnections !== undefined) params.set("orphan-max-connections", String(opts.orphanMaxConnections));
    if (opts?.godModuleChunks      !== undefined) params.set("god-module-chunks",      String(opts.godModuleChunks));
    if (opts?.godModuleFan         !== undefined) params.set("god-module-fan",          String(opts.godModuleFan));
    if (opts?.weakMaxNeighbors     !== undefined) params.set("weak-max-neighbors",      String(opts.weakMaxNeighbors));
    const qs = params.toString();
    return this.post(qs ? `/v1/smells?${qs}` : "/v1/smells", {});
  }

  async listSmells(): Promise<any> {
    return this.get("/v1/smells");
  }

  async scoreSubsystems(): Promise<any> {
    return this.post("/v1/subsystems/score", {});
  }

  async listSubsystems(): Promise<any> {
    return this.get("/v1/subsystems");
  }

  async getSubsystemMap(opts?: { target?: string; pick?: number }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.target) params.set("target", opts.target);
    if (opts?.pick !== undefined) params.set("pick", String(opts.pick));
    const qs = params.toString();
    return this.get(`/v1/subsystems/map${qs ? `?${qs}` : ""}`);
  }

  async reset(): Promise<{ ok: boolean; message: string }> {
    const resp = await fetch(`${this.endpoint}/v1/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10 * 60 * 1000), // 10 minutes
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<{ ok: boolean; message: string }>;
  }

  async resetCode(): Promise<{ ok: boolean; message: string }> {
    const resp = await fetch(`${this.endpoint}/v1/reset/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10 * 60 * 1000), // 10 minutes
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json() as Promise<{ ok: boolean; message: string }>;
  }

  async savings(detail?: boolean): Promise<any> {
    const qs = detail ? "?detail=true" : "";
    return this.get(`/v1/savings${qs}`);
  }

  async savingsReset(): Promise<any> {
    const resp = await fetch(`${this.endpoint}/v1/savings`, { method: "DELETE" });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async stats(): Promise<any> {
    return this.get("/v1/stats");
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
