# Decision Retrieval, CLI Usability & QMD Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make recorded decisions retrievable via search/query, improve CLI usability (short IDs, filters, decisions command), and integrate qmd behind a unified `ix text` command.

**Architecture:** Two sequential patches. Patch 1 is backend + CLI changes to surface decisions and add usability features. Patch 2 adds `ix text` as a thin CLI wrapper over `ripgrep` for fast lexical search (qmd is an external package that doesn't exist in this project yet and is markdown-specific — ripgrep is a better fit for general codebase text search). Both patches touch the same file set: backend Scala routes/query layer, CLI commands, client API, format module, MCP server, and types.

**Tech Stack:** Scala 2.13 + Cats Effect 3 + http4s + Circe (backend), TypeScript + Commander + MCP SDK (CLI), ArangoDB (graph DB), ripgrep (text search)

---

## Patch 1 — Decision Retrieval + CLI Usability

### Task 1: Backend — Add `/v1/decisions` endpoint

Decisions are already stored as nodes with `kind = "decision"`. We need a dedicated listing endpoint.

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/DecisionRoutes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala:9` (add method)
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala` (implement method)
- Modify: `memory-layer/src/main/scala/ix/memory/api/Routes.scala:42-44` (wire new routes)
- Modify: `memory-layer/src/main/scala/ix/memory/Main.scala:45` (pass to Routes)

**Step 1: Add `listDecisions` to the GraphQueryApi trait**

In `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`, add after line 9:

```scala
def listDecisions(limit: Int = 50, topic: Option[String] = None): IO[Vector[GraphNode]]
```

**Step 2: Implement `listDecisions` in ArangoGraphQueryApi**

In `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`, add after the `findNodesByKind` method (after line 46):

```scala
override def listDecisions(limit: Int = 50, topic: Option[String] = None): IO[Vector[GraphNode]] = {
  val topicFilter = topic match {
    case Some(t) =>
      """AND (
        |  CONTAINS(LOWER(TO_STRING(n.attrs.title)), LOWER(@topic))
        |  OR CONTAINS(LOWER(TO_STRING(n.attrs.rationale)), LOWER(@topic))
        |)""".stripMargin
    case None => ""
  }
  val aql =
    s"""FOR n IN nodes
       |  FILTER n.kind == "decision"
       |    AND n.deleted_rev == null
       |    $topicFilter
       |  SORT n.created_at DESC
       |  LIMIT @limit
       |  RETURN n""".stripMargin
  val binds = scala.collection.mutable.Map[String, AnyRef](
    "limit" -> Int.box(limit).asInstanceOf[AnyRef]
  )
  topic.foreach(t => binds += ("topic" -> t.asInstanceOf[AnyRef]))
  client.query(aql, binds.toMap).map(_.flatMap(parseNode).toVector)
}
```

**Step 3: Create DecisionRoutes.scala**

Create `memory-layer/src/main/scala/ix/memory/api/DecisionRoutes.scala`:

```scala
package ix.memory.api

import cats.effect.IO
import io.circe.Decoder
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi

case class DecisionListRequest(limit: Option[Int] = None, topic: Option[String] = None)

object DecisionListRequest {
  implicit val decoder: Decoder[DecisionListRequest] = deriveDecoder[DecisionListRequest]
}

class DecisionRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "decisions" =>
      (for {
        body  <- req.as[DecisionListRequest]
        nodes <- queryApi.listDecisions(body.limit.getOrElse(50), body.topic)
        resp  <- Ok(nodes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
```

**Step 4: Wire DecisionRoutes into Routes.scala**

In `memory-layer/src/main/scala/ix/memory/api/Routes.scala`:
- After line 40, add: `val decisionListRoutes = new DecisionRoutes(queryApi).routes`
- In the combinator chain (line 42-44), add `<+> decisionListRoutes` at the end

**Step 5: Verify backend compiles**

Run: `cd memory-layer && sbt compile`
Expected: BUILD SUCCESSFUL

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/api/DecisionRoutes.scala \
        memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala \
        memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala \
        memory-layer/src/main/scala/ix/memory/api/Routes.scala
git commit -m "feat: add /v1/decisions endpoint for listing decisions with optional topic filter"
```

---

### Task 2: Backend — Add `/v1/search` filters (kind, language, as-of)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/api/SearchRoutes.scala:14-18` (extend request model)
- Modify: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala:10` (extend signature)
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala:48-105` (filtered search)

**Step 1: Extend SearchRequest model**

In `memory-layer/src/main/scala/ix/memory/api/SearchRoutes.scala`, replace lines 14-18:

```scala
case class SearchRequest(
  term: String,
  limit: Option[Int] = None,
  kind: Option[String] = None,
  language: Option[String] = None,
  asOfRev: Option[Long] = None
)

object SearchRequest {
  implicit val decoder: Decoder[SearchRequest] = deriveDecoder[SearchRequest]
}
```

**Step 2: Update SearchRoutes handler to pass filters**

Replace the route handler (lines 22-29):

```scala
val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
  case req @ POST -> Root / "v1" / "search" =>
    (for {
      body  <- req.as[SearchRequest]
      nodes <- queryApi.searchNodes(
        body.term,
        body.limit.getOrElse(20),
        body.kind,
        body.language,
        body.asOfRev.map(Rev(_))
      )
      resp  <- Ok(nodes.asJson)
    } yield resp).handleErrorWith(ErrorHandler.handle(_))
}
```

Add `import ix.memory.model.Rev` to imports if not present.

**Step 3: Extend GraphQueryApi trait signature**

In `GraphQueryApi.scala`, replace the `searchNodes` signature (line 10):

```scala
def searchNodes(text: String, limit: Int = 20,
                kind: Option[String] = None, language: Option[String] = None,
                asOfRev: Option[Rev] = None): IO[Vector[GraphNode]]
```

**Step 4: Implement filtered search in ArangoGraphQueryApi**

Replace the `searchNodes` method (lines 48-105). The key changes:
- Add optional `FILTER n.kind == @kind` when kind is provided
- Add optional `FILTER CONTAINS(LOWER(n.provenance.source_uri), LOWER(@language))` when language is provided (language maps to file extension in source_uri)
- Use MVCC filter with asOfRev when provided, otherwise use `deleted_rev == null`

```scala
override def searchNodes(
  text: String,
  limit: Int = 20,
  kind: Option[String] = None,
  language: Option[String] = None,
  asOfRev: Option[Rev] = None
): IO[Vector[GraphNode]] = {
  val liveFilter = asOfRev match {
    case Some(r) => s"AND n.created_rev <= ${r.value} AND (n.deleted_rev == null OR ${r.value} < n.deleted_rev)"
    case None    => "AND n.deleted_rev == null"
  }
  val claimLiveFilter = asOfRev match {
    case Some(r) => s"AND c.created_rev <= ${r.value} AND (c.deleted_rev == null OR ${r.value} < c.deleted_rev)"
    case None    => "AND c.deleted_rev == null"
  }
  val kindFilter = kind.map(_ => "FILTER n2.kind == @kind").getOrElse("")
  val langFilter = language.map(_ => "FILTER CONTAINS(LOWER(TO_STRING(n2.provenance.source_uri)), LOWER(@language))").getOrElse("")

  val aql =
    s"""LET name_matches = (
       |  FOR n IN nodes
       |    FILTER CONTAINS(LOWER(n.name), LOWER(@text))
       |      $liveFilter
       |    RETURN DISTINCT n.logical_id
       |)
       |
       |LET provenance_matches = (
       |  FOR n IN nodes
       |    FILTER CONTAINS(LOWER(n.provenance.source_uri), LOWER(@text))
       |      $liveFilter
       |    RETURN DISTINCT n.logical_id
       |)
       |
       |LET claim_matches = (
       |  FOR c IN claims
       |    FILTER (
       |        CONTAINS(LOWER(c.field), LOWER(@text))
       |        OR CONTAINS(LOWER(TO_STRING(c.value)), LOWER(@text))
       |      )
       |      $claimLiveFilter
       |    RETURN DISTINCT c.entity_id
       |)
       |
       |LET decision_matches = (
       |  FOR n IN nodes
       |    FILTER n.kind == "decision"
       |      $liveFilter
       |      AND (
       |        CONTAINS(LOWER(TO_STRING(n.attrs.title)), LOWER(@text))
       |        OR CONTAINS(LOWER(TO_STRING(n.attrs.rationale)), LOWER(@text))
       |      )
       |    RETURN DISTINCT n.logical_id
       |)
       |
       |LET attr_matches = (
       |  FOR n IN nodes
       |    FILTER CONTAINS(LOWER(TO_STRING(n.attrs)), LOWER(@text))
       |      $liveFilter
       |    RETURN DISTINCT n.logical_id
       |)
       |
       |LET all_ids = UNION_DISTINCT(name_matches, provenance_matches, claim_matches, decision_matches, attr_matches)
       |
       |FOR id IN all_ids
       |  FOR n2 IN nodes
       |    FILTER n2.logical_id == id AND n2.deleted_rev == null
       |    $kindFilter
       |    $langFilter
       |  LET symbol_priority = n2.kind IN ["function", "method", "class", "trait", "object", "interface"] ? 0 : 1
       |  SORT symbol_priority ASC, n2.name ASC
       |  LIMIT @limit
       |  RETURN n2""".stripMargin

  val binds = scala.collection.mutable.Map[String, AnyRef](
    "text"  -> text.asInstanceOf[AnyRef],
    "limit" -> Int.box(limit).asInstanceOf[AnyRef]
  )
  kind.foreach(k => binds += ("kind" -> k.asInstanceOf[AnyRef]))
  language.foreach(l => binds += ("language" -> l.asInstanceOf[AnyRef]))

  client.query(aql, binds.toMap).map(_.flatMap(parseNode).toVector)
}
```

**Step 5: Verify backend compiles**

Run: `cd memory-layer && sbt compile`
Expected: BUILD SUCCESSFUL

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/api/SearchRoutes.scala \
        memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala \
        memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala
git commit -m "feat: add --kind, --language, --as-of filters to /v1/search endpoint"
```

---

### Task 3: Backend — Add `/v1/resolve-prefix` endpoint for short ID resolution

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala` (add method)
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala` (implement)
- Modify: `memory-layer/src/main/scala/ix/memory/api/EntityRoutes.scala` (add prefix route)

**Step 1: Add `resolvePrefix` to GraphQueryApi trait**

```scala
def resolvePrefix(prefix: String): IO[Vector[NodeId]]
```

**Step 2: Implement in ArangoGraphQueryApi**

```scala
override def resolvePrefix(prefix: String): IO[Vector[NodeId]] =
  client.query(
    """FOR n IN nodes
      |  FILTER n.deleted_rev == null
      |    AND STARTS_WITH(n.logical_id, @prefix)
      |  COLLECT lid = n.logical_id
      |  LIMIT 10
      |  RETURN lid""".stripMargin,
    Map("prefix" -> prefix.asInstanceOf[AnyRef])
  ).map(_.flatMap(_.asString).flatMap(s =>
    scala.util.Try(java.util.UUID.fromString(s)).toOption.map(NodeId(_))
  ).toVector)
```

**Step 3: Add prefix resolution route to EntityRoutes**

In `EntityRoutes.scala`, add a new route case before the existing `UUIDVar` case (inside the `HttpRoutes.of[IO]` block). This approach: if the path segment is a full UUID, use the existing logic; otherwise, treat it as a prefix.

Replace the entity route matcher (line 39) with a more flexible approach. Add a new route:

```scala
// GET /v1/resolve-prefix/:prefix
case GET -> Root / "v1" / "resolve-prefix" / prefix =>
  (for {
    ids  <- queryApi.resolvePrefix(prefix)
    resp <- ids.size match {
      case 0 => NotFound(Json.obj("error" -> s"No entity matches prefix: $prefix".asJson))
      case 1 => Ok(Json.obj("id" -> ids.head.value.toString.asJson))
      case _ => Ok(Json.obj(
        "error"   -> "ambiguous".asJson,
        "matches" -> ids.map(_.value.toString).asJson
      ))
    }
  } yield resp).handleErrorWith(ErrorHandler.handle(_))
```

Add `import io.circe.Json` and `import io.circe.syntax._` to EntityRoutes if not present.

**Step 4: Verify backend compiles**

Run: `cd memory-layer && sbt compile`

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala \
        memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala \
        memory-layer/src/main/scala/ix/memory/api/EntityRoutes.scala
git commit -m "feat: add /v1/resolve-prefix endpoint for short ID resolution"
```

---

### Task 4: CLI — Add `ix decisions` command

**Files:**
- Create: `ix-cli/src/cli/commands/decisions.ts`
- Modify: `ix-cli/src/client/api.ts:34` (add `listDecisions` method)
- Modify: `ix-cli/src/cli/format.ts` (add `formatDecisions`)
- Modify: `ix-cli/src/cli/main.ts` (register command)

**Step 1: Add `listDecisions` to API client**

In `ix-cli/src/client/api.ts`, add after `search()` (after line 34):

```typescript
async listDecisions(opts?: { limit?: number; topic?: string }): Promise<GraphNode[]> {
  return this.post("/v1/decisions", { limit: opts?.limit, topic: opts?.topic });
}
```

**Step 2: Add `formatDecisions` to format.ts**

In `ix-cli/src/cli/format.ts`, add after `formatNodes` (after line 93):

```typescript
export function formatDecisions(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No decisions found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.attrs?.title ?? n.name ?? "(untitled)";
    const rationale = n.attrs?.rationale ?? "";
    console.log(
      `  ${chalk.blue("*")} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
    if (rationale) {
      console.log(`    ${chalk.gray(rationale)}`);
    }
  }
}
```

**Step 3: Create decisions command**

Create `ix-cli/src/cli/commands/decisions.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatDecisions } from "../format.js";

export function registerDecisionsCommand(program: Command): void {
  program
    .command("decisions")
    .description("List recorded design decisions")
    .option("--limit <n>", "Max results", "50")
    .option("--topic <topic>", "Filter by topic keyword")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { limit: string; topic?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const nodes = await client.listDecisions({
        limit: parseInt(opts.limit, 10),
        topic: opts.topic,
      });
      formatDecisions(nodes, opts.format);
    });
}
```

**Step 4: Register in main.ts**

In `ix-cli/src/cli/main.ts`:
- Add import: `import { registerDecisionsCommand } from "./commands/decisions.js";`
- Add registration after `registerDecideCommand(program);` (after line 25): `registerDecisionsCommand(program);`

**Step 5: Verify CLI compiles**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/decisions.ts \
        ix-cli/src/client/api.ts \
        ix-cli/src/cli/format.ts \
        ix-cli/src/cli/main.ts
git commit -m "feat: add ix decisions command with --topic and --limit filters"
```

---

### Task 5: CLI — Add search filters (--kind, --language, --as-of)

**Files:**
- Modify: `ix-cli/src/cli/commands/search.ts` (add options)
- Modify: `ix-cli/src/client/api.ts:32-34` (extend search signature)

**Step 1: Extend client search method**

In `ix-cli/src/client/api.ts`, replace lines 32-34:

```typescript
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
```

**Step 2: Update search command to pass filters**

Replace `ix-cli/src/cli/commands/search.ts` entirely:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes } from "../format.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <term>")
    .description("Search the knowledge graph by term")
    .option("--limit <n>", "Max results", "20")
    .option("--kind <kind>", "Filter by node kind (e.g. method, class, decision)")
    .option("--language <lang>", "Filter by language/file extension (e.g. scala, ts)")
    .option("--as-of <rev>", "Search as of a specific revision")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (term: string, opts: {
      limit: string; kind?: string; language?: string; asOf?: string; format: string
    }) => {
      const client = new IxClient(getEndpoint());
      const nodes = await client.search(term, {
        limit: parseInt(opts.limit, 10),
        kind: opts.kind,
        language: opts.language,
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
      });
      formatNodes(nodes, opts.format);
    });
}
```

**Step 3: Update MCP ix_search tool to pass filters**

In `ix-cli/src/mcp/server.ts`, update the ix_search tool definition (around line 145-169):
- Add `kind`, `language`, `asOfRev` as optional z.string()/z.number() params
- Pass them to `client.search(term, { limit, kind, language, asOfRev })`

**Step 4: Verify CLI compiles**

Run: `cd ix-cli && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add ix-cli/src/cli/commands/search.ts \
        ix-cli/src/client/api.ts \
        ix-cli/src/mcp/server.ts
git commit -m "feat: add --kind, --language, --as-of filters to ix search"
```

---

### Task 6: CLI — Short ID prefix resolution for entity, history, expand

**Files:**
- Modify: `ix-cli/src/client/api.ts` (add `resolvePrefix` method)
- Modify: `ix-cli/src/cli/commands/entity.ts` (resolve before lookup)
- Modify: `ix-cli/src/cli/commands/history.ts` (resolve before lookup)
- Modify: `ix-cli/src/mcp/server.ts` (update ix_entity, ix_expand, ix_history tools)

**Step 1: Add `resolvePrefix` to API client**

In `ix-cli/src/client/api.ts`, add method:

```typescript
async resolvePrefix(prefix: string): Promise<string> {
  // If it's already a full UUID, return as-is
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
```

**Step 2: Update entity command**

Replace `ix-cli/src/cli/commands/entity.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerEntityCommand(program: Command): void {
  program
    .command("entity <id>")
    .description("Get entity details with claims and edges")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (id: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolvedId = await client.resolvePrefix(id);
      const result = await client.entity(resolvedId);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Entity: ${result.node.id} (${result.node.kind})`);
        console.log(`Claims: ${(result.claims as unknown[]).length}`);
        console.log(`Edges:  ${(result.edges as unknown[]).length}`);
      }
    });
}
```

**Step 3: Update history command**

Replace `ix-cli/src/cli/commands/history.ts`:

```typescript
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history <entityId>")
    .description("Show provenance chain for an entity")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (entityId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolvedId = await client.resolvePrefix(entityId);
      const result = await client.provenance(resolvedId);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    });
}
```

**Step 4: Update MCP tools (ix_entity, ix_expand, ix_history)**

In `ix-cli/src/mcp/server.ts`, for each of these three tools, add `const resolvedId = await client.resolvePrefix(id);` before the API call and use `resolvedId` instead of raw `id`.

**Step 5: Verify CLI compiles**

Run: `cd ix-cli && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/entity.ts \
        ix-cli/src/cli/commands/history.ts \
        ix-cli/src/client/api.ts \
        ix-cli/src/mcp/server.ts
git commit -m "feat: add short-ID prefix resolution for entity, history, and expand commands"
```

---

### Task 7: CLI — Update `formatNodes` to show decision kind distinctly

**Files:**
- Modify: `ix-cli/src/cli/format.ts:87-92` (enhance node display for decisions)

**Step 1: Update formatNodes**

Replace lines 87-92 in `ix-cli/src/cli/format.ts`:

```typescript
for (const n of nodes) {
  const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
  if (n.kind === "decision") {
    const title = n.attrs?.title ?? n.name ?? "(untitled)";
    console.log(
      `  ${chalk.blue("decision")}  ${chalk.dim(shortId)}  ${title}`
    );
  } else {
    console.log(
      `  ${chalk.cyan(n.kind)}  ${chalk.dim(shortId)}  ${n.attrs?.name ?? n.name ?? JSON.stringify(n.attrs)}`
    );
  }
}
```

**Step 2: Verify and commit**

Run: `cd ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/cli/format.ts
git commit -m "feat: show decisions distinctly in search results with title instead of raw attrs"
```

---

### Task 8: Tests — Add tests for new CLI features

**Files:**
- Modify: `ix-cli/src/cli/__tests__/format.test.ts` (add formatDecisions tests)

**Step 1: Write tests for formatDecisions**

Add to `ix-cli/src/cli/__tests__/format.test.ts`:

```typescript
describe("formatDecisions", () => {
  it("should output JSON when format is json", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const decisions = [
      { id: "abc-123", kind: "decision", attrs: { title: "Use ArangoDB", rationale: "Supports MVCC" } }
    ];
    formatDecisions(decisions, "json");
    expect(spy).toHaveBeenCalledWith(JSON.stringify(decisions, null, 2));
    spy.mockRestore();
  });

  it("should show 'No decisions found.' for empty list", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatDecisions([], "text");
    expect(spy).toHaveBeenCalledWith("No decisions found.");
    spy.mockRestore();
  });

  it("should display title and rationale in text mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const decisions = [
      { id: "abc-12345-def", kind: "decision", attrs: { title: "Use ArangoDB", rationale: "Supports MVCC" } }
    ];
    formatDecisions(decisions, "text");
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("Use ArangoDB");
    expect(output).toContain("Supports MVCC");
    expect(output).toContain("abc-1234"); // short ID
    spy.mockRestore();
  });
});
```

**Step 2: Run tests**

Run: `cd ix-cli && npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add ix-cli/src/cli/__tests__/format.test.ts
git commit -m "test: add formatDecisions tests"
```

---

### Task 9: MCP — Add ix_decisions tool + update ix_search

**Files:**
- Modify: `ix-cli/src/mcp/server.ts` (add ix_decisions tool)

**Step 1: Add ix_decisions tool**

In `ix-cli/src/mcp/server.ts`, add after the ix_search tool block:

```typescript
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
```

**Step 2: Verify and commit**

Run: `cd ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/mcp/server.ts
git commit -m "feat: add ix_decisions MCP tool and update ix_search with filter params"
```

---

## Patch 2 — QMD Integration Behind the Ix CLI

### Task 10: CLI — Add `ix text` command using ripgrep

The spec calls for qmd integration, but qmd is a markdown-specific external package that doesn't exist in this project. For general codebase text/blob search, we use `ripgrep` (`rg`) — it's fast, ubiquitous, and produces structured JSON output. If the user later wants to swap the backend to qmd, the CLI interface stays the same.

**Files:**
- Create: `ix-cli/src/cli/commands/text.ts`
- Modify: `ix-cli/src/cli/main.ts` (register command)
- Modify: `ix-cli/src/cli/format.ts` (add `formatTextResults`)

**Step 1: Add formatTextResults to format.ts**

In `ix-cli/src/cli/format.ts`, add:

```typescript
export interface TextResult {
  path: string;
  line: number;
  snippet: string;
  score?: number;
  symbol?: string;
}

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
    console.log(
      `  ${chalk.dim(r.path)}${chalk.cyan(":" + r.line)}  ${r.snippet.trim()}`
    );
  }
}
```

**Step 2: Create text command**

Create `ix-cli/src/cli/commands/text.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { formatTextResults, type TextResult } from "../format.js";

const execFileAsync = promisify(execFile);

export function registerTextCommand(program: Command): void {
  program
    .command("text <term>")
    .description("Fast lexical/text search across the codebase (uses ripgrep)")
    .option("--limit <n>", "Max results", "20")
    .option("--path <dir>", "Restrict search to a directory", ".")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (term: string, opts: { limit: string; path: string; format: string }) => {
      const limit = parseInt(opts.limit, 10);
      try {
        const { stdout } = await execFileAsync("rg", [
          "--json",
          "--max-count", String(limit),
          "--no-heading",
          term,
          opts.path,
        ], { maxBuffer: 10 * 1024 * 1024 });

        const results: TextResult[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") {
              const data = parsed.data;
              results.push({
                path: data.path?.text ?? "",
                line: data.line_number ?? 0,
                snippet: data.lines?.text ?? "",
              });
            }
          } catch {
            // skip non-JSON lines
          }
        }

        formatTextResults(results.slice(0, limit), opts.format);
      } catch (err: any) {
        if (err.code === "ENOENT") {
          console.error("Error: ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation");
          process.exit(1);
        }
        // rg exits with code 1 when no matches found
        if (err.code === 1 || err.status === 1) {
          formatTextResults([], opts.format);
        } else {
          throw err;
        }
      }
    });
}
```

**Step 3: Register in main.ts**

In `ix-cli/src/cli/main.ts`:
- Add import: `import { registerTextCommand } from "./commands/text.js";`
- Add registration: `registerTextCommand(program);`

**Step 4: Verify CLI compiles**

Run: `cd ix-cli && npx tsc --noEmit`

**Step 5: Smoke test**

Run: `cd /path/to/project && npx tsx /path/to/ix-cli/src/cli/main.ts text parseClaim --format json`
Expected: JSON array of `{ path, line, snippet }` objects

**Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/text.ts \
        ix-cli/src/cli/main.ts \
        ix-cli/src/cli/format.ts
git commit -m "feat: add ix text command for fast lexical search via ripgrep"
```

---

### Task 11: MCP — Add ix_text tool

**Files:**
- Modify: `ix-cli/src/mcp/server.ts` (add ix_text tool)

**Step 1: Add ix_text tool**

In `ix-cli/src/mcp/server.ts`, add a new tool:

```typescript
// --- ix_text -----------------------------------------------------------------
server.tool(
  "ix_text",
  "Fast lexical/text search across the codebase. Use for exact string matches, symbol lookups, and filename searches. For semantic questions use ix_query instead.",
  {
    term: z.string().describe("Text/pattern to search for"),
    limit: z.optional(z.number()).describe("Max results (default 20)"),
    path: z.optional(z.string()).describe("Restrict search to a directory path"),
  },
  async ({ term, limit, path }) => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const maxResults = limit ?? 20;
      const searchPath = path ?? ".";
      const { stdout } = await execFileAsync("rg", [
        "--json",
        "--max-count", String(maxResults),
        "--no-heading",
        term,
        searchPath,
      ], { maxBuffer: 10 * 1024 * 1024 });

      const results: Array<{ path: string; line: number; snippet: string }> = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "match") {
            const data = parsed.data;
            results.push({
              path: data.path?.text ?? "",
              line: data.line_number ?? 0,
              snippet: (data.lines?.text ?? "").trim(),
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
          content: [{ type: "text" as const, text: "No matches found." }],
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
```

**Step 2: Verify and commit**

Run: `cd ix-cli && npx tsc --noEmit`

```bash
git add ix-cli/src/mcp/server.ts
git commit -m "feat: add ix_text MCP tool for fast lexical search"
```

---

### Task 12: Update CLAUDE.md routing guidance

**Files:**
- Modify: `ix-cli/src/cli/commands/init.ts` (update IX_CLAUDE_MD_BLOCK template)

**Step 1: Read current init.ts**

Read the file to get exact content of the template block.

**Step 2: Add routing guidance to the CLAUDE.md template**

Add a new section to `IX_CLAUDE_MD_BLOCK` (the template injected by `ix init`):

```markdown
## Command Routing
- `ix text` — exact lexical / snippet / filename lookup (fast, uses ripgrep)
- `ix search` — graph entity search by name, kind, or attribute
- `ix query` — semantic questions about the codebase (assembles context with confidence)
- `ix decisions` — list and inspect recorded design decisions
- `ix history` / `ix diff` — temporal questions about entity changes
```

**Step 3: Update CLI help descriptions**

Verify that `ix text`, `ix search`, and `ix query` have clear, non-overlapping `.description()` strings.

**Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/init.ts
git commit -m "docs: add command routing guidance to CLAUDE.md template"
```

---

### Task 13: Tests — Add tests for text command and format

**Files:**
- Modify: `ix-cli/src/cli/__tests__/format.test.ts`

**Step 1: Write tests for formatTextResults**

```typescript
describe("formatTextResults", () => {
  it("should output JSON when format is json", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const results = [{ path: "src/foo.ts", line: 42, snippet: "const foo = bar;" }];
    formatTextResults(results, "json");
    expect(spy).toHaveBeenCalledWith(JSON.stringify(results, null, 2));
    spy.mockRestore();
  });

  it("should show 'No text matches found.' for empty results", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatTextResults([], "text");
    expect(spy).toHaveBeenCalledWith("No text matches found.");
    spy.mockRestore();
  });

  it("should display path:line and snippet in text mode", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const results = [{ path: "src/foo.ts", line: 42, snippet: "const foo = bar;" }];
    formatTextResults(results, "text");
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("src/foo.ts");
    expect(output).toContain(":42");
    expect(output).toContain("const foo = bar;");
    spy.mockRestore();
  });
});
```

**Step 2: Run tests**

Run: `cd ix-cli && npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add ix-cli/src/cli/__tests__/format.test.ts
git commit -m "test: add formatTextResults tests"
```

---

### Task 14: Final verification — Run full acceptance checklist

**Step 1: Verify backend compiles**

Run: `cd memory-layer && sbt compile`

**Step 2: Verify CLI compiles and tests pass**

Run: `cd ix-cli && npx tsc --noEmit && npm test`

**Step 3: Run acceptance checks (requires running backend)**

```bash
# A. Decision written becomes searchable
ix decide "Symbol-level extraction is the right granularity for Ix" \
  --rationale "Method/class nodes enable CALLS and IMPORTS edges."
ix search "Symbol-level extraction"
# Expected: at least one result of kind decision

# B. Decision appears in query
ix query "design decisions"
# Expected: decisions section populated

# C. Decisions listing
ix decisions
ix decisions --topic extraction
# Expected: lists decisions, topic filter narrows

# D. Short ID works
ix entity 11d0f399
# Expected: resolves entity or "no match" error

# E. Search filters
ix search parse --kind method
ix search parse --kind class
# Expected: different result sets

# F. Text search
ix text timeout_ms
ix text parseClaim --format json
# Expected: file hits with snippets
```

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: acceptance test fixups"
```

---

## File Change Summary

| File | Action | Patch |
|------|--------|-------|
| `memory-layer/.../api/DecisionRoutes.scala` | Create | 1 |
| `memory-layer/.../api/SearchRoutes.scala` | Modify | 1 |
| `memory-layer/.../api/EntityRoutes.scala` | Modify | 1 |
| `memory-layer/.../api/Routes.scala` | Modify | 1 |
| `memory-layer/.../db/GraphQueryApi.scala` | Modify | 1 |
| `memory-layer/.../db/ArangoGraphQueryApi.scala` | Modify | 1 |
| `ix-cli/src/cli/commands/decisions.ts` | Create | 1 |
| `ix-cli/src/cli/commands/search.ts` | Modify | 1 |
| `ix-cli/src/cli/commands/entity.ts` | Modify | 1 |
| `ix-cli/src/cli/commands/history.ts` | Modify | 1 |
| `ix-cli/src/cli/commands/text.ts` | Create | 2 |
| `ix-cli/src/cli/commands/init.ts` | Modify | 2 |
| `ix-cli/src/cli/main.ts` | Modify | 1+2 |
| `ix-cli/src/cli/format.ts` | Modify | 1+2 |
| `ix-cli/src/client/api.ts` | Modify | 1 |
| `ix-cli/src/mcp/server.ts` | Modify | 1+2 |
| `ix-cli/src/cli/__tests__/format.test.ts` | Modify | 1+2 |
