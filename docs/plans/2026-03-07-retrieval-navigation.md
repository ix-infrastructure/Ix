# Retrieval Unification & Graph Navigation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Link text search, graph search, and semantic query into a unified retrieval layer, and add first-class graph navigation commands (callers, imports, contains, stats, doctor).

**Architecture:** Patch 3 standardizes `ix text` output, adds `ix locate` (text→graph bridge), `ix explain` (entity summary), and text search filters. Patch 4 adds graph traversal commands that use the existing `expand` API with predicate filters. All new CLI commands are client-side — no new backend routes needed except `GET /v1/stats` for node/edge counts.

**Tech Stack:** TypeScript (Commander, chalk), Scala (http4s, AQL), ripgrep

---

## Patch 3 — Retrieval Unification

---

### Task 1: Standardize `ix text` result schema

Update the `TextResult` interface and ripgrep parser to produce the stable JSON fields required for future engine swaps.

**Files:**
- Modify: `ix-cli/src/cli/format.ts`
- Modify: `ix-cli/src/cli/commands/text.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Update TextResult interface**

In `ix-cli/src/cli/format.ts`, replace the existing `TextResult` interface:

```typescript
export interface TextResult {
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  engine: string;
  score: number;
  language?: string;
  symbol_hint?: string;
}
```

Update `formatTextResults` to use the new fields:

```typescript
export function formatTextResults(results: TextResult[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("No text matches found.");
    return;
  }
  for (const r of results) {
    const lang = r.language ? chalk.magenta(`[${r.language}]`) + " " : "";
    const sym = r.symbol_hint ? chalk.yellow(`(${r.symbol_hint})`) + " " : "";
    console.log(
      `  ${lang}${chalk.dim(r.path)}${chalk.cyan(":" + r.line_start)}  ${sym}${r.snippet.trim()}`
    );
  }
}
```

**Step 2: Update text.ts parser**

In `ix-cli/src/cli/commands/text.ts`, update the ripgrep parser to produce the new schema. Replace the result-building block inside the match handler:

```typescript
const results: TextResult[] = [];
for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === "match") {
      const data = parsed.data;
      const filePath = data.path?.text ?? "";
      const lineNum = data.line_number ?? 0;
      results.push({
        path: filePath,
        line_start: lineNum,
        line_end: lineNum,
        snippet: data.lines?.text ?? "",
        engine: "ripgrep",
        score: 1.0,
        language: inferLanguage(filePath),
      });
    }
  } catch {
    // skip non-JSON lines
  }
}
```

Add the `inferLanguage` helper at the bottom of `text.ts`:

```typescript
function inferLanguage(filePath: string): string | undefined {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".scala") || filePath.endsWith(".sc")) return "scala";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".rs")) return "rust";
  if (filePath.endsWith(".rb")) return "ruby";
  if (filePath.endsWith(".md")) return "markdown";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  return undefined;
}
```

**Step 3: Update MCP server ix_text tool**

In `ix-cli/src/mcp/server.ts`, update the ix_text tool result builder to produce the new schema. Find the results.push block inside the ix_text handler and update to match:

```typescript
results.push({
  path: data.path?.text ?? "",
  line_start: data.line_number ?? 0,
  line_end: data.line_number ?? 0,
  snippet: (data.lines?.text ?? "").trim(),
  engine: "ripgrep",
  score: 1.0,
});
```

**Step 4: Update tests**

In `ix-cli/src/cli/__tests__/format.test.ts`, update the `formatTextResults` test to use the new field names (`line_start` instead of `line`, add `engine`, `score`, `line_end`).

**Step 5: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit && npm test`

```bash
git add ix-cli/src/cli/format.ts ix-cli/src/cli/commands/text.ts ix-cli/src/mcp/server.ts ix-cli/src/cli/__tests__/format.test.ts
git commit -m "feat: standardize ix text result schema with engine, score, language fields"
```

---

### Task 2: Add text search filters (`--path`, `--limit`, `--language`)

Extend `ix text` with `--language` filter and ensure `--path` and `--limit` work properly. The `--language` filter restricts ripgrep to files with matching extensions.

**Files:**
- Modify: `ix-cli/src/cli/commands/text.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Add --language option to CLI**

In `ix-cli/src/cli/commands/text.ts`, add the option after the existing options:

```typescript
.option("--language <lang>", "Filter by language (python, typescript, scala, etc.)")
```

Update the action signature:

```typescript
.action(async (term: string, opts: { limit: string; path: string; format: string; language?: string }) => {
```

Update the ripgrep args to include language-specific glob filters:

```typescript
const rgArgs = [
  "--json",
  "--max-count", String(limit),
  "--no-heading",
];

if (opts.language) {
  const globs = languageGlobs(opts.language);
  for (const g of globs) {
    rgArgs.push("--glob", g);
  }
}

rgArgs.push(term, opts.path);

const { stdout } = await execFileAsync("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 });
```

Add the `languageGlobs` helper:

```typescript
function languageGlobs(lang: string): string[] {
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
```

**Step 2: Update MCP server ix_text tool**

Add `language` parameter to the ix_text tool schema:

```typescript
language: z.optional(z.string()).describe("Filter by language (python, typescript, scala, etc.)"),
```

And apply the same glob logic in the handler before calling rg.

**Step 3: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/cli/commands/text.ts ix-cli/src/mcp/server.ts
git commit -m "feat: add --language filter to ix text command"
```

---

### Task 3: Add `ix locate` command — bridge text hits to graph entities

`ix locate <symbol>` runs `ix text` to find occurrences, then resolves each hit to a graph entity if one exists.

**Files:**
- Create: `ix-cli/src/cli/commands/locate.ts`
- Modify: `ix-cli/src/cli/format.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Create the locate command**

Create `ix-cli/src/cli/commands/locate.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatLocateResults, type LocateResult } from "../format.js";

const execFileAsync = promisify(execFile);

export function registerLocateCommand(program: Command): void {
  program
    .command("locate <symbol>")
    .description("Find a symbol in code and resolve to graph entities")
    .option("--limit <n>", "Max text hits to check", "10")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);

      // Step 1: Search the graph for matching entities
      const graphNodes = await client.search(symbol, { limit: 5 });

      // Step 2: Run ripgrep for text hits
      let textHits: Array<{ path: string; line: number }> = [];
      try {
        const { stdout } = await execFileAsync("rg", [
          "--json", "--max-count", String(limit),
          "--no-heading", "--word-regexp",
          symbol, ".",
        ], { maxBuffer: 10 * 1024 * 1024 });

        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") {
              textHits.push({
                path: parsed.data.path?.text ?? "",
                line: parsed.data.line_number ?? 0,
              });
            }
          } catch { /* skip */ }
        }
      } catch (err: any) {
        if (err.code !== 1 && err.status !== 1 && err.code !== "ENOENT") throw err;
      }

      // Step 3: Build results — graph entities first, then unmatched text hits
      const results: LocateResult[] = [];
      for (const node of graphNodes) {
        const name = node.attrs?.name as string ?? node.kind;
        const sourceUri = node.provenance?.sourceUri;
        results.push({
          kind: node.kind,
          id: node.id,
          name,
          file: sourceUri,
          source: "graph",
        });
      }

      // Add text-only hits that didn't match any graph entity
      const graphFiles = new Set(results.map(r => r.file).filter(Boolean));
      const seenPaths = new Set<string>();
      for (const hit of textHits) {
        if (!seenPaths.has(hit.path) && !graphFiles.has(hit.path)) {
          seenPaths.add(hit.path);
          results.push({
            kind: "text-match",
            name: symbol,
            file: hit.path,
            line: hit.line,
            source: "ripgrep",
          });
        }
      }

      formatLocateResults(results, opts.format);
    });
}
```

**Step 2: Add LocateResult and formatLocateResults to format.ts**

In `ix-cli/src/cli/format.ts`, add:

```typescript
export interface LocateResult {
  kind: string;
  id?: string;
  name: string;
  file?: string;
  line?: number;
  source: "graph" | "ripgrep";
}

export function formatLocateResults(results: LocateResult[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const r of results) {
    const shortId = r.id ? chalk.dim(r.id.slice(0, 8)) + "  " : "";
    const filePart = r.file ? chalk.dim(r.file) + (r.line ? chalk.cyan(`:${r.line}`) : "") : "";
    console.log(`  ${chalk.cyan(r.kind)}  ${shortId}${chalk.bold(r.name)}`);
    if (filePart) {
      console.log(`    ${filePart}`);
    }
  }
}
```

**Step 3: Register in main.ts**

Add import and registration:

```typescript
import { registerLocateCommand } from "./commands/locate.js";
// ...
registerLocateCommand(program);
```

**Step 4: Add ix_locate MCP tool**

In `ix-cli/src/mcp/server.ts`, add a new tool that does the same logic:

```typescript
// --- ix_locate ---------------------------------------------------------------
server.tool(
  "ix_locate",
  "Locate a symbol — finds it in code via ripgrep and resolves to graph entities. Use when you need to find where something is defined and get its entity ID.",
  {
    symbol: z.string().describe("Symbol/identifier to locate"),
    limit: z.optional(z.number()).describe("Max results (default 10)"),
  },
  async ({ symbol, limit }) => {
    try {
      const maxResults = limit ?? 10;
      const graphNodes = await client.search(symbol, { limit: 5 });

      const results: Array<{ kind: string; id?: string; name: string; file?: string; source: string }> = [];
      for (const node of graphNodes) {
        results.push({
          kind: (node as any).kind,
          id: (node as any).id,
          name: (node as any).attrs?.name ?? (node as any).kind,
          file: (node as any).provenance?.sourceUri,
          source: "graph",
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results.slice(0, maxResults), null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `ix_locate failed: ${String(err)}` }],
      };
    }
  },
);
```

**Step 5: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit && npm test`

```bash
git add ix-cli/src/cli/commands/locate.ts ix-cli/src/cli/format.ts ix-cli/src/cli/main.ts ix-cli/src/mcp/server.ts
git commit -m "feat: add ix locate command — bridge text search to graph entities"
```

---

### Task 4: Add `ix explain` command — entity summary with context

`ix explain <symbol>` searches for an entity, shows its structure, container, and brief history.

**Files:**
- Create: `ix-cli/src/cli/commands/explain.ts`
- Modify: `ix-cli/src/cli/format.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Create the explain command**

Create `ix-cli/src/cli/commands/explain.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatExplain, type ExplainResult } from "../format.js";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain <symbol>")
    .description("Explain an entity — shows structure, container, and history")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Step 1: Find the entity
      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const node = nodes[0] as any;
      const entityId = node.id;

      // Step 2: Get entity details (claims, edges)
      const details = await client.entity(entityId);

      // Step 3: Get history
      let history: any = { entityId, chain: [] };
      try {
        history = await client.provenance(entityId);
      } catch { /* no history */ }

      // Step 4: Find container (CONTAINS edge pointing to this entity)
      const edges = (details.edges ?? []) as any[];
      const containsEdge = edges.find((e: any) => e.predicate === "CONTAINS" && e.dst === entityId);
      let container: any = undefined;
      if (containsEdge) {
        try {
          const containerDetails = await client.entity(containsEdge.src);
          container = containerDetails.node;
        } catch { /* no container */ }
      }

      // Step 5: Count connections
      const callEdges = edges.filter((e: any) => e.predicate === "CALLS");
      const containedEdges = edges.filter((e: any) => e.predicate === "CONTAINS" && e.src === entityId);

      const result: ExplainResult = {
        kind: node.kind,
        name: node.attrs?.name ?? node.name ?? symbol,
        id: entityId,
        file: node.provenance?.sourceUri,
        container: container ? { kind: container.kind, name: container.attrs?.name ?? container.name } : undefined,
        introducedRev: node.createdRev,
        calledBy: callEdges.filter((e: any) => e.dst === entityId).length,
        calls: callEdges.filter((e: any) => e.src === entityId).length,
        contains: containedEdges.length,
        historyLength: (history as any)?.chain?.length ?? 0,
      };

      formatExplain(result, opts.format);
    });
}
```

**Step 2: Add ExplainResult and formatExplain to format.ts**

In `ix-cli/src/cli/format.ts`, add:

```typescript
export interface ExplainResult {
  kind: string;
  name: string;
  id: string;
  file?: string;
  container?: { kind: string; name: string };
  introducedRev: number;
  calledBy: number;
  calls: number;
  contains: number;
  historyLength: number;
}

export function formatExplain(result: ExplainResult, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const shortId = result.id.slice(0, 8);
  console.log(`  ${chalk.cyan(result.kind)} ${chalk.bold(result.name)} ${chalk.dim(shortId)}`);
  if (result.container) {
    console.log(`  ${chalk.dim("in")} ${chalk.cyan(result.container.kind)} ${result.container.name}`);
  }
  if (result.file) {
    console.log(`  ${chalk.dim("file")} ${result.file}`);
  }
  console.log(`  ${chalk.dim("introduced rev")} ${result.introducedRev}`);
  if (result.calledBy > 0) console.log(`  ${chalk.dim("called by")} ${result.calledBy} methods`);
  if (result.calls > 0) console.log(`  ${chalk.dim("calls")} ${result.calls} methods`);
  if (result.contains > 0) console.log(`  ${chalk.dim("contains")} ${result.contains} members`);
  if (result.historyLength > 0) console.log(`  ${chalk.dim("history")} ${result.historyLength} patches`);
}
```

**Step 3: Register in main.ts**

```typescript
import { registerExplainCommand } from "./commands/explain.js";
// ...
registerExplainCommand(program);
```

**Step 4: Add ix_explain MCP tool**

In `ix-cli/src/mcp/server.ts`, add:

```typescript
// --- ix_explain --------------------------------------------------------------
server.tool(
  "ix_explain",
  "Explain an entity — shows its type, container, history, and connections. Use when you want a quick summary of what something is and how it relates to the codebase.",
  {
    symbol: z.string().describe("Symbol name or entity ID to explain"),
  },
  async ({ symbol }) => {
    try {
      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        return { content: [{ type: "text" as const, text: `No entity found matching "${symbol}"` }] };
      }
      const node = nodes[0] as any;
      const details = await client.entity(node.id);
      let history: any = { chain: [] };
      try { history = await client.provenance(node.id); } catch { /* ok */ }

      const edges = (details.edges ?? []) as any[];
      const containsEdge = edges.find((e: any) => e.predicate === "CONTAINS" && e.dst === node.id);
      let container: string | undefined;
      if (containsEdge) {
        try {
          const c = await client.entity(containsEdge.src);
          container = `${(c.node as any).kind} ${(c.node as any).attrs?.name ?? (c.node as any).name}`;
        } catch { /* ok */ }
      }

      const summary = {
        kind: node.kind,
        name: node.attrs?.name ?? node.name ?? symbol,
        id: node.id,
        file: node.provenance?.sourceUri,
        container,
        introducedRev: node.createdRev,
        calledBy: edges.filter((e: any) => e.predicate === "CALLS" && e.dst === node.id).length,
        calls: edges.filter((e: any) => e.predicate === "CALLS" && e.src === node.id).length,
        contains: edges.filter((e: any) => e.predicate === "CONTAINS" && e.src === node.id).length,
        historyLength: history?.chain?.length ?? 0,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `ix_explain failed: ${String(err)}` }],
      };
    }
  },
);
```

**Step 5: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit && npm test`

```bash
git add ix-cli/src/cli/commands/explain.ts ix-cli/src/cli/format.ts ix-cli/src/cli/main.ts ix-cli/src/mcp/server.ts
git commit -m "feat: add ix explain command — entity summary with structure and history"
```

---

## Patch 4 — Graph Navigation + CLI Improvements

---

### Task 5: Add `ix callers` and `ix callees` commands

These use the existing `expand` API with predicate filter `CALLS`.

**Files:**
- Create: `ix-cli/src/cli/commands/callers.ts`
- Modify: `ix-cli/src/client/api.ts`
- Modify: `ix-cli/src/cli/format.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Add expand method to API client**

In `ix-cli/src/client/api.ts`, add:

```typescript
async expand(
  id: string,
  opts?: { direction?: string; predicates?: string[]; hops?: number }
): Promise<{ nodes: GraphNode[]; edges: any[] }> {
  return this.post("/v1/expand", {
    nodeId: id,
    direction: opts?.direction ?? "both",
    predicates: opts?.predicates,
    hops: opts?.hops ?? 1,
  });
}
```

**Step 2: Add expand backend route**

The backend already has `queryApi.expand()` but no HTTP endpoint for it. Add one.

Create `memory-layer/src/main/scala/ix/memory/api/ExpandRoutes.scala`:

```scala
package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.{Direction, GraphQueryApi}
import ix.memory.model._

case class ExpandRequest(
  nodeId: String,
  direction: Option[String] = None,
  predicates: Option[List[String]] = None,
  hops: Option[Int] = None,
  asOfRev: Option[Long] = None
)

object ExpandRequest {
  implicit val decoder: Decoder[ExpandRequest] = deriveDecoder[ExpandRequest]
}

class ExpandRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "expand" =>
      (for {
        body <- req.as[ExpandRequest]
        nodeId <- IO.fromOption(
          scala.util.Try(UUID.fromString(body.nodeId)).toOption.map(NodeId(_))
        )(new IllegalArgumentException(s"Invalid node ID: ${body.nodeId}"))
        dir = body.direction match {
          case Some("in")  => Direction.In
          case Some("out") => Direction.Out
          case _           => Direction.Both
        }
        preds = body.predicates.map(_.toSet)
        result <- queryApi.expand(nodeId, dir, preds, body.hops.getOrElse(1), body.asOfRev.map(Rev(_)))
        resp <- Ok(result.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
```

Note: This requires `ExpandResult` to have an Encoder. Check if it exists — if not, add it.

**Step 3: Add ExpandResult encoder if missing**

In `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`, check if `ExpandResult` has an encoder. If not, add:

```scala
object ExpandResult {
  implicit val encoder: Encoder[ExpandResult] = deriveEncoder[ExpandResult]
}
```

This requires adding the import `import io.circe.generic.semiauto.deriveEncoder` at the top.

**Step 4: Wire ExpandRoutes into Routes.scala**

In `memory-layer/src/main/scala/ix/memory/api/Routes.scala`, add:

```scala
val expandRoutes = new ExpandRoutes(queryApi).routes
```

And add `<+> expandRoutes` to the combined routes.

**Step 5: Create callers command**

Create `ix-cli/src/cli/commands/callers.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Find the entity
      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      // Expand inbound CALLS edges
      const result = await client.expand(entityId, { direction: "in", predicates: ["CALLS"] });

      formatEdgeResults(result.nodes as any[], "callers", symbol, opts.format);
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "out", predicates: ["CALLS"] });

      formatEdgeResults(result.nodes as any[], "callees", symbol, opts.format);
    });
}
```

**Step 6: Add formatEdgeResults to format.ts**

```typescript
export function formatEdgeResults(nodes: any[], relation: string, symbol: string, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log(`No ${relation} found for "${symbol}".`);
    return;
  }
  console.log(`${chalk.bold(relation)} of ${chalk.cyan(symbol)}:`);
  for (const n of nodes) {
    const shortId = n.id?.slice(0, 8) ?? "";
    const name = n.attrs?.name ?? n.name ?? n.id;
    console.log(`  ${chalk.cyan(n.kind)}  ${chalk.dim(shortId)}  ${name}`);
  }
}
```

**Step 7: Register in main.ts**

```typescript
import { registerCallersCommand } from "./commands/callers.js";
// ...
registerCallersCommand(program);
```

**Step 8: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory && sbt compile`
Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit`

```bash
git add memory-layer/src/main/scala/ix/memory/api/ExpandRoutes.scala \
        memory-layer/src/main/scala/ix/memory/api/Routes.scala \
        memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala \
        ix-cli/src/cli/commands/callers.ts \
        ix-cli/src/cli/format.ts \
        ix-cli/src/cli/main.ts \
        ix-cli/src/client/api.ts \
        ix-cli/src/mcp/server.ts
git commit -m "feat: add ix callers/callees commands with expand backend route"
```

---

### Task 6: Add `ix imports` and `ix imported-by` commands

Same pattern as callers/callees but with `IMPORTS` predicate.

**Files:**
- Create: `ix-cli/src/cli/commands/imports.ts`
- Modify: `ix-cli/src/cli/main.ts`

**Step 1: Create imports command**

Create `ix-cli/src/cli/commands/imports.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";

export function registerImportsCommand(program: Command): void {
  program
    .command("imports <symbol>")
    .description("Show what the given entity imports")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "out", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes as any[], "imports", symbol, opts.format);
    });

  program
    .command("imported-by <symbol>")
    .description("Show what imports the given entity")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "in", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes as any[], "imported-by", symbol, opts.format);
    });
}
```

**Step 2: Register in main.ts**

```typescript
import { registerImportsCommand } from "./commands/imports.js";
// ...
registerImportsCommand(program);
```

**Step 3: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/cli/commands/imports.ts ix-cli/src/cli/main.ts
git commit -m "feat: add ix imports/imported-by commands"
```

---

### Task 7: Add `ix contains` command

Uses `CONTAINS` predicate to show members of a class/module.

**Files:**
- Create: `ix-cli/src/cli/commands/contains.ts`
- Modify: `ix-cli/src/cli/main.ts`

**Step 1: Create contains command**

Create `ix-cli/src/cli/commands/contains.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";

export function registerContainsCommand(program: Command): void {
  program
    .command("contains <symbol>")
    .description("Show members contained by the given entity (class, module, file)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "out", predicates: ["CONTAINS"] });
      formatEdgeResults(result.nodes as any[], "contains", symbol, opts.format);
    });
}
```

**Step 2: Register in main.ts**

```typescript
import { registerContainsCommand } from "./commands/contains.js";
// ...
registerContainsCommand(program);
```

**Step 3: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/cli/commands/contains.ts ix-cli/src/cli/main.ts
git commit -m "feat: add ix contains command for entity member listing"
```

---

### Task 8: Add `ix stats` command — graph statistics

Add a backend endpoint that returns aggregate counts and a CLI command to display them.

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/StatsRoutes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/api/Routes.scala`
- Create: `ix-cli/src/cli/commands/stats.ts`
- Modify: `ix-cli/src/client/api.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Create backend stats endpoint**

Create `memory-layer/src/main/scala/ix/memory/api/StatsRoutes.scala`:

```scala
package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.ArangoClient

class StatsRoutes(client: ArangoClient) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "stats" =>
      (for {
        nodeStats <- client.query(
          """FOR n IN nodes
            |  FILTER n.deleted_rev == null
            |  COLLECT kind = n.kind WITH COUNT INTO cnt
            |  SORT cnt DESC
            |  RETURN { kind: kind, count: cnt }""".stripMargin,
          Map.empty[String, AnyRef]
        )
        edgeStats <- client.query(
          """FOR e IN edges
            |  FILTER e.deleted_rev == null
            |  COLLECT predicate = e.predicate WITH COUNT INTO cnt
            |  SORT cnt DESC
            |  RETURN { predicate: predicate, count: cnt }""".stripMargin,
          Map.empty[String, AnyRef]
        )
        totalNodes <- client.query(
          """RETURN LENGTH(FOR n IN nodes FILTER n.deleted_rev == null RETURN 1)""",
          Map.empty[String, AnyRef]
        )
        totalEdges <- client.query(
          """RETURN LENGTH(FOR e IN edges FILTER e.deleted_rev == null RETURN 1)""",
          Map.empty[String, AnyRef]
        )
        resp <- Ok(Json.obj(
          "nodes" -> Json.obj(
            "total" -> totalNodes.headOption.flatMap(_.asNumber).flatMap(_.toInt).getOrElse(0).asJson,
            "byKind" -> nodeStats.asJson
          ),
          "edges" -> Json.obj(
            "total" -> totalEdges.headOption.flatMap(_.asNumber).flatMap(_.toInt).getOrElse(0).asJson,
            "byPredicate" -> edgeStats.asJson
          )
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
```

**Step 2: Wire into Routes.scala**

Add to `Routes.scala`:

```scala
val statsRoutes = new StatsRoutes(client).routes
```

Add `<+> statsRoutes` to the combined routes.

**Step 3: Add stats API method**

In `ix-cli/src/client/api.ts`:

```typescript
async stats(): Promise<any> {
  return this.get("/v1/stats");
}
```

**Step 4: Create CLI stats command**

Create `ix-cli/src/cli/commands/stats.ts`:

```typescript
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show graph statistics — node/edge counts by type")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.stats();

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold("\nnodes") + chalk.dim(` (${result.nodes.total} total)`));
      for (const entry of result.nodes.byKind) {
        const kind = entry.kind ?? "unknown";
        const count = entry.count ?? 0;
        console.log(`  ${chalk.cyan(kind)}: ${count}`);
      }

      console.log(chalk.bold("\nedges") + chalk.dim(` (${result.edges.total} total)`));
      for (const entry of result.edges.byPredicate) {
        const pred = entry.predicate ?? "unknown";
        const count = entry.count ?? 0;
        console.log(`  ${chalk.cyan(pred)}: ${count}`);
      }
      console.log();
    });
}
```

**Step 5: Register in main.ts and add MCP tool**

Register in main.ts:

```typescript
import { registerStatsCommand } from "./commands/stats.js";
// ...
registerStatsCommand(program);
```

Add MCP tool in server.ts:

```typescript
// --- ix_stats ----------------------------------------------------------------
server.tool(
  "ix_stats",
  "Show graph statistics — total nodes and edges with breakdown by kind/predicate. Use to verify ingestion and understand graph size.",
  {},
  async () => {
    try {
      const stats = await client.stats();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `ix_stats failed: ${String(err)}` }],
      };
    }
  },
);
```

**Step 6: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory && sbt compile`
Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit`

```bash
git add memory-layer/src/main/scala/ix/memory/api/StatsRoutes.scala \
        memory-layer/src/main/scala/ix/memory/api/Routes.scala \
        ix-cli/src/cli/commands/stats.ts \
        ix-cli/src/client/api.ts \
        ix-cli/src/cli/main.ts \
        ix-cli/src/mcp/server.ts
git commit -m "feat: add ix stats command with graph statistics endpoint"
```

---

### Task 9: Add `ix doctor` command — graph integrity check

Client-side command that uses existing APIs to detect issues.

**Files:**
- Create: `ix-cli/src/cli/commands/doctor.ts`
- Modify: `ix-cli/src/cli/main.ts`
- Modify: `ix-cli/src/mcp/server.ts`

**Step 1: Create doctor command**

Create `ix-cli/src/cli/commands/doctor.ts`:

```typescript
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check graph integrity — detect orphans, missing edges, duplicates")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const issues: Array<{ type: string; severity: string; message: string }> = [];

      // 1. Check backend health
      try {
        await client.health();
      } catch {
        issues.push({ type: "connectivity", severity: "error", message: "Backend is not reachable" });
        if (opts.format === "json") {
          console.log(JSON.stringify({ issues }, null, 2));
        } else {
          console.log(chalk.red("Error: Backend is not reachable."));
        }
        return;
      }

      // 2. Check graph stats for anomalies
      try {
        const stats = await client.stats();
        const totalNodes = stats.nodes?.total ?? 0;
        const totalEdges = stats.edges?.total ?? 0;

        if (totalNodes === 0) {
          issues.push({ type: "empty_graph", severity: "warning", message: "Graph is empty — run ix ingest first" });
        } else if (totalEdges === 0 && totalNodes > 1) {
          issues.push({ type: "no_edges", severity: "warning", message: `${totalNodes} nodes but 0 edges — relationships may not be parsed` });
        }

        // Check for very low edge:node ratio
        if (totalNodes > 10 && totalEdges / totalNodes < 0.1) {
          issues.push({
            type: "sparse_graph",
            severity: "info",
            message: `Low edge:node ratio (${totalEdges}/${totalNodes} = ${(totalEdges / totalNodes).toFixed(2)}) — graph may be sparsely connected`,
          });
        }
      } catch (err) {
        issues.push({ type: "stats_error", severity: "error", message: `Could not fetch stats: ${err}` });
      }

      // 3. Check for conflicts
      try {
        const conflicts = await client.conflicts();
        if (conflicts.length > 0) {
          issues.push({
            type: "conflicts",
            severity: "warning",
            message: `${conflicts.length} unresolved conflicts detected`,
          });
        }
      } catch { /* ok */ }

      // Output
      if (opts.format === "json") {
        console.log(JSON.stringify({ issues, healthy: issues.filter(i => i.severity === "error").length === 0 }, null, 2));
        return;
      }

      if (issues.length === 0) {
        console.log(chalk.green("✓ Graph looks healthy — no issues detected."));
      } else {
        for (const issue of issues) {
          const icon = issue.severity === "error" ? chalk.red("✗")
            : issue.severity === "warning" ? chalk.yellow("!")
            : chalk.blue("i");
          console.log(`  ${icon} ${issue.message}`);
        }
        const errors = issues.filter(i => i.severity === "error").length;
        if (errors === 0) {
          console.log(chalk.green("\n✓ No critical issues."));
        } else {
          console.log(chalk.red(`\n✗ ${errors} critical issue(s) found.`));
        }
      }
    });
}
```

**Step 2: Register in main.ts**

```typescript
import { registerDoctorCommand } from "./commands/doctor.js";
// ...
registerDoctorCommand(program);
```

**Step 3: Add MCP tool**

In `ix-cli/src/mcp/server.ts`:

```typescript
// --- ix_doctor ---------------------------------------------------------------
server.tool(
  "ix_doctor",
  "Check graph integrity — detects empty graphs, missing edges, conflicts, and connectivity issues.",
  {},
  async () => {
    try {
      const issues: Array<{ type: string; severity: string; message: string }> = [];

      try { await client.health(); } catch {
        return { content: [{ type: "text" as const, text: JSON.stringify({ issues: [{ type: "connectivity", severity: "error", message: "Backend not reachable" }], healthy: false }, null, 2) }] };
      }

      try {
        const stats = await client.stats();
        if ((stats.nodes?.total ?? 0) === 0) {
          issues.push({ type: "empty_graph", severity: "warning", message: "Graph is empty" });
        }
      } catch { /* ok */ }

      try {
        const conflicts = await client.conflicts();
        if (conflicts.length > 0) {
          issues.push({ type: "conflicts", severity: "warning", message: `${conflicts.length} unresolved conflicts` });
        }
      } catch { /* ok */ }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ issues, healthy: issues.filter(i => i.severity === "error").length === 0 }, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `ix_doctor failed: ${String(err)}` }],
      };
    }
  },
);
```

**Step 4: Verify and commit**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit && npm test`

```bash
git add ix-cli/src/cli/commands/doctor.ts ix-cli/src/cli/main.ts ix-cli/src/mcp/server.ts
git commit -m "feat: add ix doctor command for graph integrity checking"
```

---

### Task 10: Final verification

**Step 1: Backend compilation**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory && sbt compile`
Expected: `[success]`

**Step 2: CLI type check and tests**

Run: `cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli && npx tsc --noEmit && npm test`
Expected: All tests pass

**Step 3: Review git log**

Run: `git log --oneline -12`
Expected: Clean commit history

**Step 4: Manual smoke test**

```bash
cd /Users/rileythompson/startprojes/startup/giter/IX-Memory/ix-cli

# Text search with new schema
npx tsx src/cli/main.ts text parseClaim --json

# Locate
npx tsx src/cli/main.ts locate parseClaim

# Explain
npx tsx src/cli/main.ts explain parseClaim

# Graph navigation
npx tsx src/cli/main.ts callers parseClaim
npx tsx src/cli/main.ts contains ArangoGraphQueryApi

# Stats
npx tsx src/cli/main.ts stats

# Doctor
npx tsx src/cli/main.ts doctor
```

---

## Summary of New Commands

| Command | Patch | Description |
|---------|-------|-------------|
| `ix text` (updated) | 3 | Standardized schema + --language filter |
| `ix locate <symbol>` | 3 | Bridge text→graph entities |
| `ix explain <symbol>` | 3 | Entity summary with context |
| `ix callers <symbol>` | 4 | Show what calls this symbol |
| `ix callees <symbol>` | 4 | Show what this symbol calls |
| `ix imports <entity>` | 4 | Show imports |
| `ix imported-by <entity>` | 4 | Show importers |
| `ix contains <entity>` | 4 | Show contained members |
| `ix stats` | 4 | Graph node/edge counts |
| `ix doctor` | 4 | Graph integrity check |

## New Backend Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/expand` | POST | Expand node neighborhood with predicate filters |
| `/v1/stats` | GET | Graph statistics (node/edge counts by kind) |
