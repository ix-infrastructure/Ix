import type {
  CommitResult,
  IngestResult,
  StructuredContext,
  GraphNode,
  HealthResponse,
  PatchSummary,
  GraphPatchPayload,
  PatchCommitResult,
  CapabilitiesResponse,
} from "./types.js";

export interface ListSubsystemsOptions {
  detailed?: boolean;
  limit?: number;
  offset?: number;
  regions?: string;
  edgeCap?: number;
  memberFileCap?: number;
}

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
    opts?: { limit?: number; kind?: string; language?: string; asOfRev?: number; nameOnly?: boolean; workspaceId?: string }
  ): Promise<GraphNode[]> {
    return this.post("/v1/search", {
      term,
      limit: opts?.limit,
      kind: opts?.kind,
      language: opts?.language,
      asOfRev: opts?.asOfRev,
      nameOnly: opts?.nameOnly,
      workspaceId: opts?.workspaceId,
    });
  }

  async listByKind(
    kind: string,
    opts?: { limit?: number; workspaceId?: string; scope?: string }
  ): Promise<GraphNode[]> {
    return this.post("/v1/list", {
      kind,
      limit: opts?.limit,
      workspaceId: opts?.workspaceId,
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

  async map(opts?: { full?: boolean; workspaceId?: string }): Promise<any> {
    // /v1/map reads snake_case keys (full, branch_id, workspace_id) off the raw JSON body.
    const body: Record<string, unknown> = { full: opts?.full ?? false };
    if (opts?.workspaceId) body.workspace_id = opts.workspaceId;
    const resp = await fetch(`${this.endpoint}/v1/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    workspaceId?: string;
  }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.orphanMaxConnections !== undefined) params.set("orphan-max-connections", String(opts.orphanMaxConnections));
    if (opts?.godModuleChunks      !== undefined) params.set("god-module-chunks",      String(opts.godModuleChunks));
    if (opts?.godModuleFan         !== undefined) params.set("god-module-fan",          String(opts.godModuleFan));
    if (opts?.weakMaxNeighbors     !== undefined) params.set("weak-max-neighbors",      String(opts.weakMaxNeighbors));
    if (opts?.workspaceId)                        params.set("workspace_id",            opts.workspaceId);
    const qs = params.toString();
    return this.post(qs ? `/v1/smells?${qs}` : "/v1/smells", {});
  }

  async listSmells(opts?: { workspaceId?: string }): Promise<any> {
    const qs = opts?.workspaceId ? `?workspace_id=${encodeURIComponent(opts.workspaceId)}` : "";
    return this.get(`/v1/smells${qs}`);
  }

  async scoreSubsystems(opts?: { workspaceId?: string }): Promise<any> {
    const qs = opts?.workspaceId ? `?workspace_id=${encodeURIComponent(opts.workspaceId)}` : "";
    return this.post(`/v1/subsystems/score${qs}`, {});
  }

  async listSubsystems(opts?: ListSubsystemsOptions & { workspaceId?: string }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.detailed) params.set("detailed", "true");
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.regions) params.set("regions", opts.regions);
    if (opts?.edgeCap !== undefined) params.set("edge_cap", String(opts.edgeCap));
    if (opts?.memberFileCap !== undefined) params.set("member_file_cap", String(opts.memberFileCap));
    if (opts?.workspaceId) params.set("workspace_id", opts.workspaceId);
    const qs = params.toString();
    return this.get(`/v1/subsystems${qs ? `?${qs}` : ""}`);
  }

  async getSubsystemMap(opts?: { target?: string; pick?: number; workspaceId?: string }): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.target) params.set("target", opts.target);
    if (opts?.pick !== undefined) params.set("pick", String(opts.pick));
    if (opts?.workspaceId) params.set("workspace_id", opts.workspaceId);
    const qs = params.toString();
    return this.get(`/v1/subsystems/map${qs ? `?${qs}` : ""}`);
  }

  async reset(): Promise<{ ok: boolean; message: string }> {
    return this.runReset(
      "/v1/reset/async",
      "/v1/reset",
      "Graph reset. All nodes and edges deleted.",
    );
  }

  async resetCode(): Promise<{ ok: boolean; message: string }> {
    return this.runReset(
      "/v1/reset/code/async",
      "/v1/reset/code",
      "Code graph reset. Planning artifacts (goals, plans, tasks, bugs, decisions) preserved.",
    );
  }

  // True when the configured endpoint is a local memory-layer. A local
  // backend has no proxy in front of it, so the sync reset path connects
  // directly and returns in milliseconds — there is nothing to fix there.
  private isLocalEndpoint(): boolean {
    try {
      const host = new URL(this.endpoint).hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
    } catch {
      return false;
    }
  }

  // Reset can take minutes on a large graph. Against a cloud deployment a
  // single sync request outlives the GCLB stream timeout → spurious 502
  // even though the truncate succeeded. So for a remote endpoint we drive
  // the async endpoint — begin returns immediately, then poll for status.
  //
  // For a local endpoint there is no proxy and the truncate is near-instant,
  // so we keep the original sync request unchanged — identical behavior for
  // OSS and Pro users running against a local memory-layer.
  //
  // If a remote backend predates the async endpoints (404 on begin), fall
  // back to the sync request so old deployments still work.
  private async runReset(
    asyncPath: string,
    syncPath: string,
    doneMessage: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.isLocalEndpoint()) {
      return this.runResetSync(syncPath);
    }

    const beginResp = await fetch(`${this.endpoint}${asyncPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30 * 1000),
    });

    if (beginResp.status === 404) {
      return this.runResetSync(syncPath);
    }
    if (!beginResp.ok) {
      const text = await beginResp.text();
      throw new Error(`${beginResp.status}: ${text}`);
    }

    const { opId } = (await beginResp.json()) as { opId: string };
    const deadlineMs = Date.now() + 15 * 60 * 1000;

    while (Date.now() < deadlineMs) {
      const statusResp = await fetch(`${this.endpoint}/v1/reset/status/${opId}`, {
        method: "GET",
        signal: AbortSignal.timeout(30 * 1000),
      });
      // Op state is in-process on the server — a restart drops it. Reset is
      // idempotent, so the safe recovery is to tell the user to re-run.
      if (statusResp.status === 404) {
        throw new Error(
          `Reset status for operation ${opId} was lost (the server may have ` +
          `restarted). Reset is idempotent — re-run the command to confirm.`,
        );
      }
      if (!statusResp.ok) {
        const text = await statusResp.text();
        throw new Error(`${statusResp.status}: ${text}`);
      }
      const status = (await statusResp.json()) as { state: string; error?: string | null };
      if (status.state === "done") {
        return { ok: true, message: doneMessage };
      }
      if (status.state === "failed") {
        throw new Error(`Reset failed: ${status.error ?? "unknown error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Reset did not complete within 15 minutes (operation ${opId}).`);
  }

  private async runResetSync(syncPath: string): Promise<{ ok: boolean; message: string }> {
    const resp = await fetch(`${this.endpoint}${syncPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10 * 60 * 1000),
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

  async stats(opts?: { workspaceId?: string }): Promise<any> {
    const qs = opts?.workspaceId ? `?workspace_id=${encodeURIComponent(opts.workspaceId)}` : "";
    return this.get(`/v1/stats${qs}`);
  }

  async health(): Promise<HealthResponse> {
    return this.get("/v1/health");
  }

  async capabilities(): Promise<CapabilitiesResponse> {
    try {
      return await this.get<CapabilitiesResponse>("/v1/capabilities");
    } catch {
      // Backend doesn't support capabilities yet — fall back to local mode.
      return {};
    }
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
