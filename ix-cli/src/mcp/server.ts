/**
 * Ix Memory MCP Server
 *
 * Exposes 13 tools and 2 resources over the Model Context Protocol,
 * providing persistent, time-aware memory to LLM coding assistants.
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

MANDATORY RULES:
1. ALWAYS call ix_query before answering questions about the codebase — if you are about to answer and have not called ix_query yet, STOP and call it first
2. AFTER any design decision, call ix_decide to record it with full reasoning
3. When you notice conflicting information, call ix_conflicts and present results to the user
4. NEVER answer from training data alone when Ix has structured data available
5. After modifying code, call ix_ingest IMMEDIATELY on changed files — not at end of session
6. At start of each session, review ix://session/context for prior work and decisions
7. When the user states a goal, call ix_truth to record the intent so decisions trace back to it

BEHAVIORAL CHECKS:
- About to answer a codebase question? → Did you call ix_query? If not, STOP and call it.
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

// --- ix_query ---------------------------------------------------------------
server.tool(
  "ix_query",
  "ALWAYS call this tool BEFORE answering any question about the codebase, architecture, or technical decisions. Ix Memory contains structured, versioned knowledge with confidence scores. Never rely on your training data alone when Ix has data available. Results include confidence scores — mention uncertainty to the user when confidence is low.",
  {
    question: z.string().describe("The question to ask the knowledge graph"),
    asOfRev: z.optional(z.number()).describe("Optional revision snapshot"),
    depth: z.optional(z.string()).describe("Query depth: shallow | deep"),
  },
  async ({ question, asOfRev, depth }) => {
    try {
      const ctx = await client.query(question, { asOfRev, depth });
      // Track session
      session.track({ type: "query", summary: question, timestamp: new Date().toISOString() });
      if (ctx.nodes) {
        session.trackEntities(ctx.nodes.map((n: any) => n.id));
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ctx, null, 2) }],
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
  "Expand a node's neighborhood — retrieve connected nodes and edges.",
  {
    nodeId: z.string().describe("Node ID to expand from"),
    hops: z
      .optional(z.number())
      .describe("Number of hops to traverse (default 1)"),
    direction: z
      .optional(z.string())
      .describe("Edge direction: in | out | both (default both)"),
  },
  async ({ nodeId, hops: _hops, direction: _direction }) => {
    try {
      const resolvedId = await client.resolvePrefix(nodeId);
      // The entity endpoint already returns edges; use it as the expansion source.
      const entity = await client.entity(resolvedId);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(entity, null, 2) },
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

// ============================= START ========================================

const transport = new StdioServerTransport();
await server.connect(transport);
