/**
 * Ix Memory MCP Server (Compatibility Only)
 *
 * The CLI (`ix` commands) is now the canonical agent interface.
 * This MCP server is retained for backward compatibility but is
 * no longer the recommended integration path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IxClient } from "../client/api.js";
import { SessionState } from "./session.js";

// ---------------------------------------------------------------------------
// Server instructions — sent to the LLM at connection time
// ---------------------------------------------------------------------------
export const INSTRUCTIONS = `You have access to Ix Memory — a persistent, time-aware knowledge graph for this codebase.
Ix returns structured context: nodes, edges, claims, conflicts, and decisions — each with confidence scores.

NOTE: The ix CLI is now the canonical agent interface. Prefer running CLI commands
(ix search, ix explain, ix callers, etc.) over these MCP tools when possible.
These MCP tools are retained for backward compatibility.

MANDATORY RULES:
1. BEFORE answering codebase questions, use targeted Ix tools (NOT ix_query — it is deprecated)
2. AFTER any design decision, call ix_decide to record it with full reasoning
3. When you notice conflicting information, call ix_conflicts and present results to the user
4. NEVER answer from training data alone when Ix has structured data available
5. After modifying code, call ix_ingest IMMEDIATELY on changed files — not at end of session
6. When the user states a goal, call ix_truth to record the intent so decisions trace back to it

AVOID ix_query:
- ix_query is DEPRECATED — it produces broad, oversized, low-signal responses
- Instead, decompose questions into targeted tool calls
- Example: "how does ingestion work?" → ix_search "IngestionService" → ix_entity <id> → ix_expand <id>

BEHAVIORAL CHECKS:
- About to answer a codebase question? → Use ix_search + ix_entity + ix_expand, NOT ix_query
- Just made a design choice? → Call ix_decide before moving on.
- Just edited a file? → Call ix_ingest now, not later.
- See something contradictory? → Call ix_conflicts before proceeding.
- Low confidence in Ix results? → Tell the user and suggest re-ingesting.`;

// ---------------------------------------------------------------------------
// Client – uses IX_ENDPOINT env var or defaults to localhost:8090
// ---------------------------------------------------------------------------
const client = new IxClient(process.env.IX_ENDPOINT ?? "http://localhost:8090");
const session = new SessionState();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "ix-memory", version: "0.1.0" },
  { instructions: INSTRUCTIONS },
);

// ============================= TOOLS =======================================

// --- ix_query [DEPRECATED] ---------------------------------------------------
server.tool(
  "ix_query",
  "[DEPRECATED] Broad NLP-style graph query — produces oversized, low-signal responses. Use targeted tools instead: ix_search (find entities), ix_entity (get details), ix_expand (traverse edges), ix_text (lexical search), ix_decisions (past decisions). Decompose questions into specific tool calls rather than issuing a single broad query.",
  {
    question: z.string().describe("The question to ask the knowledge graph"),
    asOfRev: z.optional(z.number()).describe("Optional revision snapshot"),
    depth: z.optional(z.string()).describe("Query depth: shallow | deep"),
  },
  async ({ question, asOfRev, depth }) => {
    const deprecationWarning = [
      "⚠ ix_query is DEPRECATED — broad NLP-style queries produce oversized, low-signal responses.",
      "",
      "Prefer these targeted alternatives:",
      "  ix_search — find entities by name/kind",
      "  ix_entity — get full entity details by ID",
      "  ix_expand — traverse edges (CALLS, IMPORTS, CONTAINS)",
      "  ix_text — fast lexical search (ripgrep)",
      "  ix_decisions — list design decisions",
      "  ix_history — entity change history",
      "  ix_diff — changes between revisions",
      "",
      "Decompose broad questions into specific tool calls.",
      "Example: 'how does ingestion work?' →",
      "  1. ix_search 'IngestionService'",
      "  2. ix_entity <id>",
      "  3. ix_expand <id> direction=out predicates=[CONTAINS]",
      "",
      "--- query results follow (not recommended) ---",
      "",
    ].join("\n");

    try {
      const ctx = await client.query(question, { asOfRev, depth });
      // Track session
      session.track({ type: "query", summary: question, timestamp: new Date().toISOString() });
      if (ctx.nodes) {
        session.trackEntities(ctx.nodes.map((n: any) => n.id));
      }
      return {
        content: [{ type: "text" as const, text: deprecationWarning + JSON.stringify(ctx, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_query failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_ingest ---------------------------------------------------------------
server.tool(
  "ix_ingest",
  "Ingest source files into the Ix knowledge graph. Do this IMMEDIATELY after file changes, not at the end of the session. Stale memory causes wrong answers in future sessions.",
  {
    path: z.string().describe("File or directory path to ingest"),
    recursive: z.optional(z.boolean()).describe("Recurse into subdirectories"),
  },
  async ({ path, recursive }) => {
    try {
      const result = await client.ingest(path, recursive);
      // Track session
      session.track({ type: "ingest", summary: path, timestamp: new Date().toISOString() });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_ingest failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_decide ---------------------------------------------------------------
server.tool(
  "ix_decide",
  "Record a design decision in the knowledge graph. Always call after making an architectural or design choice. This creates a permanent record — include the reasoning, not just the conclusion.",
  {
    title: z.string().describe("Short title of the decision"),
    rationale: z.string().describe("Why this decision was made"),
    intentId: z
      .optional(z.string())
      .describe("Optional intent this decision fulfils"),
  },
  async ({ title, rationale, intentId }) => {
    try {
      const result = await client.decide(title, rationale, { intentId });
      // Track session
      session.track({ type: "decision", id: result.nodeId, summary: title, timestamp: new Date().toISOString() });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_decide failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_search ---------------------------------------------------------------
server.tool(
  "ix_search",
  "Search nodes in the knowledge graph by term.",
  {
    term: z.string().describe("Search term"),
    limit: z.optional(z.number()).describe("Max results to return"),
    kind: z.optional(z.string()).describe("Filter by node kind (e.g. method, class, decision)"),
    language: z.optional(z.string()).describe("Filter by language/file extension (e.g. scala, ts)"),
    asOfRev: z.optional(z.number()).describe("Search as of a specific revision"),
  },
  async ({ term, limit, kind, language, asOfRev }) => {
    try {
      const nodes = await client.search(term, { limit, kind, language, asOfRev });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(nodes, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_search failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_decisions -------------------------------------------------------------
server.tool(
  "ix_decisions",
  "List recorded design decisions. Use this to review past architectural choices and their rationale.",
  {
    limit: z.optional(z.number()).describe("Max results (default 50)"),
    topic: z.optional(z.string()).describe("Filter decisions by topic keyword"),
  },
  async ({ limit, topic }) => {
    try {
      const nodes = await client.listDecisions({ limit, topic });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(nodes, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_decisions failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_entity ---------------------------------------------------------------
server.tool(
  "ix_entity",
  "Get full details for an entity (node, claims, edges) by its ID.",
  {
    id: z.string().describe("Entity / node ID (UUID)"),
  },
  async ({ id }) => {
    try {
      const resolvedId = await client.resolvePrefix(id);
      const entity = await client.entity(resolvedId);
      // Track session
      session.track({ type: "entity", id: resolvedId, summary: `Looked up entity ${resolvedId}`, timestamp: new Date().toISOString() });
      session.trackEntities([resolvedId]);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(entity, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_entity failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_assert ---------------------------------------------------------------
server.tool(
  "ix_assert",
  "Assert a claim about an entity. Currently delegates to the ingestion pipeline — use ix_ingest to update claims through file ingestion.",
  {
    entityId: z.string().describe("Target entity ID"),
    field: z.string().describe("Claim field / attribute name"),
    value: z.string().describe("Claim value"),
  },
  async ({ entityId, field, value }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Assertion noted: entity=${entityId} field=${field} value=${value}`,
            "",
            "Direct claim assertion is not yet available as a standalone endpoint.",
            "To persist this claim, use ix_ingest to re-ingest the source file",
            "that contains this entity, and the parser will extract updated claims.",
          ].join("\n"),
        },
      ],
    };
  },
);

// --- ix_diff -----------------------------------------------------------------
server.tool(
  "ix_diff",
  "Show what changed between two revisions of the knowledge graph.",
  {
    fromRev: z.number().describe("Starting revision"),
    toRev: z.number().describe("Ending revision"),
    entityId: z
      .optional(z.string())
      .describe("Optional entity to scope the diff to"),
  },
  async ({ fromRev, toRev, entityId }) => {
    try {
      const diff = await client.diff(fromRev, toRev, entityId);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(diff, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_diff failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_conflicts ------------------------------------------------------------
server.tool(
  "ix_conflicts",
  "List all detected conflicts in the knowledge graph. Call when you notice contradictory information. If any conflicts are found, present them to the user before proceeding.",
  {},
  async () => {
    try {
      const conflicts = await client.conflicts();
      // Track session
      session.track({ type: "conflict", summary: "Checked conflicts", timestamp: new Date().toISOString() });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(conflicts, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `ix_conflicts failed: ${String(err)}`,
          },
        ],
      };
    }
  },
);

// --- ix_resolve --------------------------------------------------------------
server.tool(
  "ix_resolve",
  "Resolve a detected conflict. Currently, record the resolution as a design decision using ix_decide.",
  {
    conflictId: z.string().describe("ID of the conflict to resolve"),
    resolution: z
      .string()
      .describe("Description of how the conflict was resolved"),
  },
  async ({ conflictId, resolution }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Resolution noted for conflict ${conflictId}: ${resolution}`,
            "",
            "Direct conflict resolution is not yet available as a standalone endpoint.",
            "To persist this resolution, call ix_decide with the resolution rationale.",
            "This will record the decision and link it to the relevant intents.",
          ].join("\n"),
        },
      ],
    };
  },
);

// --- ix_expand ---------------------------------------------------------------
server.tool(
  "ix_expand",
  "Expand a node's neighborhood — retrieve connected nodes and edges. Filter by direction and edge predicates (CALLS, IMPORTS, CONTAINS, etc.).",
  {
    nodeId: z.string().describe("Node ID to expand from"),
    hops: z
      .optional(z.number())
      .describe("Number of hops to traverse (default 1)"),
    direction: z
      .optional(z.string())
      .describe("Edge direction: in | out | both (default both)"),
    predicates: z
      .optional(z.array(z.string()))
      .describe("Filter by edge predicates (e.g. ['CALLS', 'IMPORTS'])"),
  },
  async ({ nodeId, hops, direction, predicates }) => {
    try {
      const resolvedId = await client.resolvePrefix(nodeId);
      const result = await client.expand(resolvedId, { direction, predicates, hops });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_expand failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_history --------------------------------------------------------------
server.tool(
  "ix_history",
  "Get the provenance chain for an entity — the full history of patches that created or modified it.",
  {
    entityId: z.string().describe("Entity ID to get history for"),
  },
  async ({ entityId }) => {
    try {
      const resolvedId = await client.resolvePrefix(entityId);
      const history = await client.provenance(resolvedId);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(history, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_history failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_truth ----------------------------------------------------------------
server.tool(
  "ix_truth",
  "Manage project intents (goals). Use action 'list' to see current intents, or 'add' to record a new goal. The user's stated goals guide all decisions — always check intents before major work.",
  {
    action: z.enum(["list", "add"]).describe("Action: list or add"),
    statement: z
      .optional(z.string())
      .describe("Intent statement (required when action is 'add')"),
    parentIntent: z
      .optional(z.string())
      .describe("Parent intent ID for hierarchical goals"),
  },
  async ({ action, statement, parentIntent }) => {
    try {
      if (action === "list") {
        const intents = await client.listTruth();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(intents, null, 2) },
          ],
        };
      } else {
        if (!statement) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "The 'statement' parameter is required when action is 'add'.",
              },
            ],
          };
        }
        const result = await client.createTruth(statement, parentIntent);
        // Track session
        session.track({ type: "truth", summary: statement, timestamp: new Date().toISOString() });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_truth failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_text -----------------------------------------------------------------
server.tool(
  "ix_text",
  "Fast lexical/text search across the codebase. Use for exact string matches, symbol lookups, and filename searches. Combine with ix_search and ix_entity for comprehensive results.",
  {
    term: z.string().describe("Text/pattern to search for"),
    limit: z.optional(z.number()).describe("Max results (default 20)"),
    path: z.optional(z.string()).describe("Restrict search to a directory path"),
    language: z.optional(z.string()).describe("Filter by language (python, typescript, scala, etc.)"),
  },
  async ({ term, limit, path, language }) => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const maxResults = limit ?? 20;
      const searchPath = path ?? ".";
      const rgArgs = [
        "--json",
        "--max-count", String(maxResults),
        "--no-heading",
      ];

      if (language) {
        for (const g of ixTextLanguageGlobs(language)) {
          rgArgs.push("--glob", g);
        }
      }

      rgArgs.push(term, searchPath);

      const { stdout } = await execFileAsync("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 });

      const results: Array<{ path: string; line_start: number; line_end: number; snippet: string; engine: string; score: number }> = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "match") {
            const data = parsed.data;
            results.push({
              path: data.path?.text ?? "",
              line_start: data.line_number ?? 0,
              line_end: data.line_number ?? 0,
              snippet: (data.lines?.text ?? "").trim(),
              engine: "ripgrep",
              score: 1.0,
            });
          }
        } catch { /* skip */ }
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results.slice(0, maxResults), null, 2) },
        ],
      };
    } catch (err: any) {
      if (err.code === 1 || err.status === 1) {
        return {
          content: [{ type: "text" as const, text: "[]" }],
        };
      }
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_text failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_patches --------------------------------------------------------------
server.tool(
  "ix_patches",
  "List all patches, or get a specific patch by ID.",
  {
    patchId: z
      .optional(z.string())
      .describe("If provided, fetch this specific patch; otherwise list all"),
  },
  async ({ patchId }) => {
    try {
      if (patchId) {
        const patch = await client.getPatch(patchId);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(patch, null, 2) },
          ],
        };
      } else {
        const patches = await client.listPatches();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(patches, null, 2) },
          ],
        };
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_patches failed: ${String(err)}` },
        ],
      };
    }
  },
);

// --- ix_stats ----------------------------------------------------------------
server.tool(
  "ix_stats",
  "Get graph statistics — total node/edge counts broken down by kind and predicate.",
  {},
  async () => {
    try {
      const result = await client.stats();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `ix_stats failed: ${String(err)}` },
        ],
      };
    }
  },
);

// ============================= RESOURCES ====================================

// --- ix://session/context ----------------------------------------------------
server.resource(
  "ix-session-context",
  "ix://session/context",
  { description: "Session working set — entities queried, decisions made, files ingested in this session" },
  async (uri) => {
    const summary = session.getSummary();
    let contextData: any = { session: summary };

    // If there are queried entities, include a fresh context query
    if (summary.queriedEntities.length > 0) {
      try {
        const ctx = await client.query(
          `entities: ${summary.queriedEntities.slice(0, 5).join(", ")}`,
          {},
        );
        contextData.latestContext = ctx;
      } catch {
        // Session data is still useful even without fresh query
      }
    }

    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(contextData, null, 2) }],
    };
  },
);

// --- ix://project/intent -----------------------------------------------------
server.resource(
  "ix-project-intent",
  "ix://project/intent",
  { description: "Current project intent tree — the goals and sub-goals for this project" },
  async (uri) => {
    let text: string;
    try {
      const intents = await client.listTruth();
      text = JSON.stringify(intents, null, 2);
    } catch {
      text = [
        "Ix Memory intent data is unavailable (server may not be running).",
        "Start the Ix Memory Layer server and try again.",
      ].join("\n");
    }
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text }],
    };
  },
);

// ============================= HELPERS ======================================

function ixTextLanguageGlobs(lang: string): string[] {
  switch (lang) {
    case "python": return ["*.py"];
    case "typescript": return ["*.ts", "*.tsx"];
    case "javascript": return ["*.js", "*.jsx", "*.mjs", "*.cjs"];
    case "scala": return ["*.scala", "*.sc"];
    case "java": return ["*.java"];
    case "go": return ["*.go"];
    case "rust": return ["*.rs"];
    case "ruby": return ["*.rb"];
    case "markdown": return ["*.md", "*.mdx"];
    case "config": return ["*.json", "*.yaml", "*.yml", "*.toml"];
    default: return [`*.${lang}`];
  }
}

// ============================= START ========================================

const transport = new StdioServerTransport();
await server.connect(transport);
