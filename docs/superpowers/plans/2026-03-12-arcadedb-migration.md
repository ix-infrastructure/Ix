# ArcadeDB Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ArangoDB (Docker, network) with ArcadeDB embedded (in-process, zero infrastructure) behind existing `GraphQueryApi`/`GraphWriteApi` traits.

**Architecture:** Add ArcadeDB dependency, implement `ArcadeClient`, `ArcadeSchema`, `ArcadeGraphQueryApi`, `ArcadeGraphWriteApi` behind existing traits. Rewire `Main.scala`. All code above the DB layer remains unchanged.

**Tech Stack:** Scala 2.13, ArcadeDB 26.1.1 (arcadedb-engine), Cats Effect 3, Http4s, Circe, ScalaTest

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `memory-layer/src/main/scala/ix/memory/db/ArcadeClient.scala` | Embedded DB lifecycle (open/close), query/command helpers, transaction wrappers |
| `memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala` | Vertex/edge type creation, index creation, migration runner |
| `memory-layer/src/main/scala/ix/memory/db/ArcadeGraphQueryApi.scala` | All read queries (SQL) implementing `GraphQueryApi` trait |
| `memory-layer/src/main/scala/ix/memory/db/ArcadeGraphWriteApi.scala` | All write ops implementing `GraphWriteApi` trait |
| `memory-layer/src/main/scala/ix/memory/db/ArcadeBulkWriteApi.scala` | Bulk ingestion using ArcadeDB async API |
| `memory-layer/src/test/scala/ix/memory/db/ArcadeClientSpec.scala` | Client lifecycle tests |
| `memory-layer/src/test/scala/ix/memory/db/ArcadeGraphWriteApiSpec.scala` | Write API tests (port from GraphWriteApiSpec) |
| `memory-layer/src/test/scala/ix/memory/db/ArcadeGraphQueryApiSpec.scala` | Query API tests (port from GraphQueryApiSpec) |
| `memory-layer/src/test/scala/ix/memory/db/ArcadeBulkWriteApiSpec.scala` | Bulk write tests |

### Modified Files

| File | Change |
|------|--------|
| `build.sbt` | Add arcadedb-engine dep, remove arangodb-java-driver |
| `memory-layer/src/main/scala/ix/memory/Main.scala` | Wire Arcade instead of Arango |
| `memory-layer/src/test/scala/ix/memory/TestDbHelper.scala` | Add Arcade cleanup helper |

### Retained (No Changes)

- `GraphQueryApi.scala` (trait — unchanged)
- `GraphWriteApi.scala` (trait — unchanged)
- All parsers, ingestion, context, conflict, model, API routes

### Deprecated (Keep Until Fully Validated)

- `ArangoClient.scala`, `ArangoGraphQueryApi.scala`, `ArangoGraphWriteApi.scala`, `ArangoSchema.scala`, `BulkWriteApi.scala`
- Remove after all tests pass with Arcade backend

---

## Chunk 1: Foundation — ArcadeClient + Schema

### Task 1: Add ArcadeDB dependency to build.sbt

**Files:**
- Modify: `build.sbt`

- [ ] **Step 1: Add ArcadeDB engine dependency**

In `build.sbt`, add to `libraryDependencies`:

```scala
"com.arcadedb" % "arcadedb-engine" % "26.1.1",
```

Keep the ArangoDB dependency for now (we'll remove it after full migration).

- [ ] **Step 2: Verify compilation**

Run: `sbt compile`
Expected: Compiles successfully with new dependency resolved

- [ ] **Step 3: Commit**

```bash
git add build.sbt
git commit -m "build: add arcadedb-engine dependency"
```

---

### Task 2: Implement ArcadeClient

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArcadeClient.scala`
- Test: `memory-layer/src/test/scala/ix/memory/db/ArcadeClientSpec.scala`

- [ ] **Step 1: Write the test file**

```scala
package ix.memory.db

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers
import java.nio.file.Files

class ArcadeClientSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  "ArcadeClient" should "create and open a database" in {
    val tmpDir = Files.createTempDirectory("ix-arcade-test").toString
    ArcadeClient.resource(tmpDir).use { client =>
      for {
        _ <- client.ensureSchema()
      } yield succeed
    }
  }

  it should "execute a query and return results" in {
    val tmpDir = Files.createTempDirectory("ix-arcade-test").toString
    ArcadeClient.resource(tmpDir).use { client =>
      for {
        _       <- client.ensureSchema()
        results <- client.query("SELECT FROM ix_nodes LIMIT 1")
      } yield {
        results shouldBe empty
      }
    }
  }

  it should "execute commands within a transaction" in {
    val tmpDir = Files.createTempDirectory("ix-arcade-test").toString
    ArcadeClient.resource(tmpDir).use { client =>
      for {
        _ <- client.ensureSchema()
        _ <- client.transact { db =>
          IO {
            db.newVertex("ix_nodes")
              .set("logical_id", "test-id")
              .set("kind", "function")
              .set("name", "testFunc")
              .save()
          }
        }
        results <- client.query("SELECT FROM ix_nodes WHERE name = 'testFunc'")
      } yield {
        results.length shouldBe 1
      }
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sbt "testOnly ix.memory.db.ArcadeClientSpec"`
Expected: FAIL — ArcadeClient class doesn't exist

- [ ] **Step 3: Implement ArcadeClient**

```scala
package ix.memory.db

import cats.effect.{IO, Resource}
import com.arcadedb.database.{Database, DatabaseFactory}
import io.circe.Json
import io.circe.parser.{parse => parseJson}

class ArcadeClient private (db: Database) {

  /** Read-only SQL query returning list of JSON results. */
  def query(sql: String, params: Map[String, AnyRef] = Map.empty): IO[List[Json]] = IO.blocking {
    val javaParams = new java.util.HashMap[String, java.lang.Object]()
    params.foreach { case (k, v) => javaParams.put(k, v) }
    val rs = db.query("sql", sql, javaParams)
    try {
      val buf = List.newBuilder[Json]
      while (rs.hasNext) {
        val row = rs.next()
        val jsonStr = row.toJSON
        parseJson(jsonStr).foreach(buf += _)
      }
      buf.result()
    } finally rs.close()
  }

  /** Single result query. */
  def queryOne(sql: String, params: Map[String, AnyRef] = Map.empty): IO[Option[Json]] =
    query(sql, params).map(_.headOption)

  /** Mutating SQL command. */
  def command(sql: String, params: Map[String, AnyRef] = Map.empty): IO[Unit] = IO.blocking {
    val javaParams = new java.util.HashMap[String, java.lang.Object]()
    params.foreach { case (k, v) => javaParams.put(k, v) }
    val rs = db.command("sql", sql, javaParams)
    rs.close()
  }

  /** Execute a block within a transaction. Auto-commits on success, rolls back on failure. */
  def transact[A](body: Database => IO[A]): IO[A] = {
    IO.blocking(db.begin()) *>
      body(db).attempt.flatMap {
        case Right(a) => IO.blocking(db.commit()) *> IO.pure(a)
        case Left(e)  => IO.blocking(db.rollback()) *> IO.raiseError(e)
      }
  }

  /** Access the raw database for direct operations (bulk inserts etc). */
  def raw: Database = db

  /** Initialize schema (vertex types, edge types, indexes). */
  def ensureSchema(): IO[Unit] = ArcadeSchema.ensure(db)
}

object ArcadeClient {

  def resource(dbPath: String): Resource[IO, ArcadeClient] =
    Resource.make(open(dbPath))(client => IO.blocking(client.raw.close()))

  private def open(dbPath: String): IO[ArcadeClient] = IO.blocking {
    val factory = new DatabaseFactory(dbPath)
    val db = if (factory.exists()) factory.open() else factory.create()
    new ArcadeClient(db)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `sbt "testOnly ix.memory.db.ArcadeClientSpec"`
Expected: PASS (all 3 tests, after ArcadeSchema stub exists)

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeClient.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeClientSpec.scala
git commit -m "feat: add ArcadeClient with embedded DB lifecycle"
```

---

### Task 3: Implement ArcadeSchema

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala`

- [ ] **Step 1: Write a test for schema creation**

Add to `ArcadeClientSpec.scala`:

```scala
it should "create all vertex and edge types" in {
  val tmpDir = Files.createTempDirectory("ix-arcade-test").toString
  ArcadeClient.resource(tmpDir).use { client =>
    for {
      _ <- client.ensureSchema()
      // Verify vertex types exist by querying their schema
      types <- IO.blocking {
        val schema = client.raw.getSchema
        List("ix_nodes", "ix_claims", "ix_patches", "ix_revisions", "ix_idempotency_keys", "ix_conflict_sets")
          .map(t => t -> schema.existsType(t))
          .toMap
      }
      edgeTypes <- IO.blocking {
        val schema = client.raw.getSchema
        schema.existsType("ix_edges")
      }
    } yield {
      types.values.foreach(_ shouldBe true)
      edgeTypes shouldBe true
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sbt "testOnly ix.memory.db.ArcadeClientSpec"`
Expected: FAIL — ArcadeSchema.ensure not implemented

- [ ] **Step 3: Implement ArcadeSchema**

```scala
package ix.memory.db

import cats.effect.IO
import com.arcadedb.database.Database
import com.arcadedb.schema.Schema

object ArcadeSchema {

  def ensure(db: Database): IO[Unit] = IO.blocking {
    db.transaction(_ => {

      val schema = db.getSchema

      // ── Vertex types ──
      schema.getOrCreateVertexType("ix_nodes")
      schema.getOrCreateVertexType("ix_claims")
      schema.getOrCreateVertexType("ix_patches")
      schema.getOrCreateVertexType("ix_revisions")
      schema.getOrCreateVertexType("ix_idempotency_keys")
      schema.getOrCreateVertexType("ix_conflict_sets")
      schema.getOrCreateVertexType("ix_meta")

      // ── Edge type ──
      schema.getOrCreateEdgeType("ix_edges")

      // ── Indexes on ix_nodes ──
      ensureIndex(schema, "ix_nodes", false, "kind")
      ensureIndex(schema, "ix_nodes", false, "name")
      ensureIndex(schema, "ix_nodes", false, "logical_id")
      ensureIndex(schema, "ix_nodes", false, "source_uri")

      // ── Indexes on ix_edges ──
      ensureIndex(schema, "ix_edges", false, "src")
      ensureIndex(schema, "ix_edges", false, "dst")
      ensureIndex(schema, "ix_edges", false, "predicate")

      // ── Indexes on ix_claims ──
      ensureIndex(schema, "ix_claims", false, "entity_id")
      ensureIndex(schema, "ix_claims", false, "status")
      ensureIndex(schema, "ix_claims", false, "field")

      // ── Indexes on ix_patches ──
      ensureIndex(schema, "ix_patches", true, "patch_id")

      // ── Indexes on ix_idempotency_keys ──
      ensureIndex(schema, "ix_idempotency_keys", true, "key")
    })
  }

  private def ensureIndex(
    schema: Schema, typeName: String, unique: Boolean, fields: String*
  ): Unit = {
    val existingIndexes = schema.getType(typeName).getAllIndexes(true)
    val alreadyExists = {
      val it = existingIndexes.iterator()
      var found = false
      while (it.hasNext && !found) {
        val idx = it.next()
        val props = idx.getPropertyNames
        found = fields.forall(f => props.contains(f)) && props.size() == fields.size
      }
      found
    }
    if (!alreadyExists) {
      schema.getOrCreateTypeIndex(
        if (unique) Schema.INDEX_TYPE.LSM_TREE else Schema.INDEX_TYPE.LSM_TREE,
        unique,
        typeName,
        fields.toArray
      )
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `sbt "testOnly ix.memory.db.ArcadeClientSpec"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeClientSpec.scala
git commit -m "feat: add ArcadeSchema with vertex/edge types and indexes"
```

---

## Chunk 2: Write API — ArcadeGraphWriteApi

### Task 4: Implement ArcadeGraphWriteApi

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArcadeGraphWriteApi.scala`
- Create: `memory-layer/src/test/scala/ix/memory/db/ArcadeGraphWriteApiSpec.scala`

- [ ] **Step 1: Write the test file**

Port the existing `GraphWriteApiSpec` tests but use ArcadeClient instead of ArangoClient. All 5 existing tests must be replicated:

1. Commit a patch and increment revision
2. Be idempotent on duplicate patch_id
3. Reject on base_rev mismatch
4. Persist node visible via query
5. Soft delete node via MVCC

```scala
package ix.memory.db

import java.time.Instant
import java.util.UUID
import java.nio.file.Files

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.BeforeAndAfterEach

import ix.memory.model._

class ArcadeGraphWriteApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private val tmpDir = Files.createTempDirectory("ix-arcade-write-test").toString

  private val clientResource = ArcadeClient.resource(tmpDir)

  private def makePatch(
    baseRev: Rev = Rev(0L),
    ops: Vector[PatchOp] = Vector.empty,
    patchId: PatchId = PatchId(UUID.randomUUID())
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = PatchSource(
        uri        = "test://source",
        sourceHash = Some("hash123"),
        extractor  = "test-extractor",
        sourceType = SourceType.Code
      ),
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  "ArcadeGraphWriteApi" should "commit a patch and increment revision" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        patch   = makePatch(ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "testFunc",
            Map("lang" -> Json.fromString("scala")))
        ))
        result <- api.commitPatch(patch)
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value should be > 0L
      }
    }
  }

  it should "be idempotent on duplicate patch_id" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArcadeGraphWriteApi(client)
        nodeId   = NodeId(UUID.randomUUID())
        patchId  = PatchId(UUID.randomUUID())
        patch    = makePatch(patchId = patchId, ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Module, "testModule", Map.empty[String, Json])
        ))
        result1 <- api.commitPatch(patch)
        result2 <- api.commitPatch(patch)
      } yield {
        result1.status shouldBe CommitStatus.Ok
        result2.status shouldBe CommitStatus.Idempotent
        result2.newRev shouldBe result1.newRev
      }
    }
  }

  it should "reject on base_rev mismatch" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArcadeGraphWriteApi(client)
        patch1   = makePatch(ops = Vector(
          PatchOp.UpsertNode(NodeId(UUID.randomUUID()), NodeKind.Service, "svc1", Map.empty[String, Json])
        ))
        _       <- api.commitPatch(patch1)
        patch2   = makePatch(baseRev = Rev(999L), ops = Vector(
          PatchOp.UpsertNode(NodeId(UUID.randomUUID()), NodeKind.Service, "svc2", Map.empty[String, Json])
        ))
        result  <- api.commitPatch(patch2)
      } yield {
        result.status shouldBe CommitStatus.BaseRevMismatch
      }
    }
  }

  it should "persist node visible via query" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        patch   = makePatch(ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.File, "Main.scala",
            Map("path" -> Json.fromString("/src/Main.scala")))
        ))
        _      <- api.commitPatch(patch)
        result <- client.query(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        result.length shouldBe 1
        val doc = result.head
        doc.hcursor.get[String]("kind") shouldBe Right("file")
        doc.hcursor.get[String]("name") shouldBe Right("Main.scala")
      }
    }
  }

  it should "soft delete node via MVCC" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        patch1  = makePatch(ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Class, "MyClass", Map.empty[String, Json])
        ))
        res1   <- api.commitPatch(patch1)
        patch2  = makePatch(baseRev = res1.newRev, ops = Vector(PatchOp.DeleteNode(nodeId)))
        res2   <- api.commitPatch(patch2)
        result <- client.query(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NOT NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        res1.status shouldBe CommitStatus.Ok
        res2.status shouldBe CommitStatus.Ok
        res2.newRev.value shouldBe res1.newRev.value + 1
        result.length shouldBe 1
      }
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphWriteApiSpec"`
Expected: FAIL — ArcadeGraphWriteApi doesn't exist

- [ ] **Step 3: Implement ArcadeGraphWriteApi**

Create `ArcadeGraphWriteApi.scala` implementing `GraphWriteApi` trait. Key implementation details:

- Use `client.transact` for atomic commits
- Implement same MVCC pattern: `created_rev`, `deleted_rev` fields on nodes/edges
- Idempotency check: query `ix_idempotency_keys` by patch_id before commit
- Base rev check: query `ix_revisions` for current rev, compare to patch.baseRev
- UpsertNode: query for existing live row by `logical_id`, tombstone if exists, insert new versioned row
- UpsertEdge: SQL UPSERT with `deleted_rev = null`
- DeleteNode/DeleteEdge: set `deleted_rev` on matching row
- AssertClaim: retire conflicting claims, check for duplicates, insert
- RetractClaim: set `status = 'retracted'` and `deleted_rev`
- Store patch, idempotency key, update revision counter

The implementation follows the exact same logic as `ArangoGraphWriteApi` but uses ArcadeDB SQL instead of AQL.

- [ ] **Step 4: Run tests**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphWriteApiSpec"`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeGraphWriteApi.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeGraphWriteApiSpec.scala
git commit -m "feat: add ArcadeGraphWriteApi with MVCC and idempotency"
```

---

## Chunk 3: Query API — ArcadeGraphQueryApi

### Task 5: Implement ArcadeGraphQueryApi (core methods)

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArcadeGraphQueryApi.scala`
- Create: `memory-layer/src/test/scala/ix/memory/db/ArcadeGraphQueryApiSpec.scala`

- [ ] **Step 1: Write the test file**

Port all 7 tests from `GraphQueryApiSpec`:

1. getNode returns a committed node
2. getNode respects MVCC visibility
3. findNodesByKind returns nodes of given kind
4. expand returns connected nodes and edges
5. searchNodes finds nodes by name
6. getClaims returns active claims for entity
7. getLatestRev returns current revision

Use same test structure as `ArcadeGraphWriteApiSpec` (temp dir, ArcadeClient.resource).

- [ ] **Step 2: Run tests to verify they fail**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphQueryApiSpec"`
Expected: FAIL — ArcadeGraphQueryApi doesn't exist

- [ ] **Step 3: Implement core query methods**

Implement the `GraphQueryApi` trait. Key SQL translations from AQL:

| Method | AQL Pattern | ArcadeDB SQL Pattern |
|--------|------------|---------------------|
| `getNode` | `FOR n IN nodes FILTER n.logical_id == @id AND n.deleted_rev == null` | `SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL` |
| `findNodesByKind` | `FOR n IN nodes FILTER n.kind == @kind AND n.deleted_rev == null` | `SELECT FROM ix_nodes WHERE kind = :kind AND deleted_rev IS NULL LIMIT :limit` |
| `searchNodes` | Multi-LET union with weights | SQL UNION with scoring subqueries |
| `expand` | `FOR e IN edges FILTER e.src == @id` + batch node fetch | `SELECT FROM ix_edges WHERE src = :id AND deleted_rev IS NULL` + batch `SELECT FROM ix_nodes WHERE logical_id IN [...]` |
| `getClaims` | `FOR c IN claims FILTER c.entity_id == @id AND c.deleted_rev == null` | `SELECT FROM ix_claims WHERE entity_id = :id AND deleted_rev IS NULL` |
| `getLatestRev` | `FOR r IN revisions FILTER r._key == "current"` | `SELECT FROM ix_revisions WHERE key = 'current'` |

Important: use `client.query()` for all reads. Parse results through same `parseNode`/`parseEdge`/`parseClaim` helpers (adapted for ArcadeDB JSON format).

- [ ] **Step 4: Run tests**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphQueryApiSpec"`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeGraphQueryApi.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeGraphQueryApiSpec.scala
git commit -m "feat: add ArcadeGraphQueryApi with core query methods"
```

---

### Task 6: Implement remaining query methods

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArcadeGraphQueryApi.scala`

- [ ] **Step 1: Write tests for remaining methods**

Add tests for:
- `getPatchesForEntity` — commit a patch, query patches by entity ID
- `getPatchesBySource` — query patches by source URI + extractor
- `getChangedEntities` — commit two patches, diff between revisions
- `getDiffSummary` — verify added/modified/removed counts
- `resolvePrefix` — create node, resolve by UUID prefix
- `getSourceHashes` — commit patch with source hash, retrieve it
- `expandByName` — create connected nodes, expand by name
- `listDecisions` — create decision nodes, list them

- [ ] **Step 2: Run tests to verify they fail**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphQueryApiSpec"`
Expected: FAIL — methods not yet implemented

- [ ] **Step 3: Implement remaining methods**

Translate the remaining AQL queries to ArcadeDB SQL. Key patterns:

- `getPatchesForEntity`: `SELECT FROM ix_patches WHERE data LIKE '%entityId%'` (or store entity IDs as indexed field)
- `getDiffSummary`: Two-pass query comparing node states between revisions
- `resolvePrefix`: `SELECT FROM ix_nodes WHERE logical_id LIKE :prefix`
- `expandByName`: `SELECT FROM ix_nodes WHERE name = :name` → then expand
- `listDecisions`: `SELECT FROM ix_nodes WHERE kind = 'decision' ORDER BY created_at DESC`

- [ ] **Step 4: Run all query tests**

Run: `sbt "testOnly ix.memory.db.ArcadeGraphQueryApiSpec"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeGraphQueryApi.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeGraphQueryApiSpec.scala
git commit -m "feat: complete ArcadeGraphQueryApi with all query methods"
```

---

## Chunk 4: Bulk Write + Wiring

### Task 7: Implement ArcadeBulkWriteApi

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArcadeBulkWriteApi.scala`
- Create: `memory-layer/src/test/scala/ix/memory/db/ArcadeBulkWriteApiSpec.scala`

- [ ] **Step 1: Write bulk insert test**

```scala
"ArcadeBulkWriteApi" should "commit a batch of file patches" in {
  clientResource.use { client =>
    for {
      _      <- client.ensureSchema()
      api     = new ArcadeBulkWriteApi(client)
      // Create 3 file batches with nodes and edges
      batches = (1 to 3).map { i =>
        val nodeId = NodeId(UUID.randomUUID())
        ArcadeFileBatch(
          filePath = s"/src/file$i.scala",
          sourceHash = Some(s"hash$i"),
          patch = makePatch(ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.File, s"file$i.scala", Map.empty[String, Json])
          )),
          provenance = Map.empty
        )
      }.toVector
      result <- api.commitBatch(batches, Rev(0L))
      query  <- new ArcadeGraphQueryApi(client).findNodesByKind(NodeKind.File)
    } yield {
      result.status shouldBe CommitStatus.Ok
      query.length shouldBe 3
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sbt "testOnly ix.memory.db.ArcadeBulkWriteApiSpec"`
Expected: FAIL

- [ ] **Step 3: Implement ArcadeBulkWriteApi**

Use ArcadeDB's synchronous transaction-based bulk insert (not the async API initially — simpler and sufficient for our scale):

- Group patches into chunks (100 per batch)
- For each chunk: open transaction, insert all nodes/edges/claims, store patches, update revision, commit
- Tombstone existing nodes before inserting new versions
- Retire old claims

- [ ] **Step 4: Run test**

Run: `sbt "testOnly ix.memory.db.ArcadeBulkWriteApiSpec"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeBulkWriteApi.scala
git add memory-layer/src/test/scala/ix/memory/db/ArcadeBulkWriteApiSpec.scala
git commit -m "feat: add ArcadeBulkWriteApi for batch ingestion"
```

---

### Task 8: Rewire Main.scala

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/Main.scala`

- [ ] **Step 1: Write integration test**

Add to `EndToEndSpec.scala` or create new `ArcadeEndToEndSpec.scala`:

```scala
"The server" should "start with ArcadeDB and respond to health check" in {
  // Verify Main wiring compiles and server starts
  // Test /v1/health endpoint returns ok
}
```

- [ ] **Step 2: Update Main.scala wiring**

Replace ArangoDB wiring with ArcadeDB:

```scala
// BEFORE:
val client = ArangoClient.resource(host, port, database, user, password)
// write = new ArangoGraphWriteApi(client)
// query = new ArangoGraphQueryApi(client)
// bulk  = new BulkWriteApi(client)

// AFTER:
val dbPath = sys.env.getOrElse("IX_DATA_DIR",
  s"${sys.props("user.home")}/.local/share/ix/data/graph")
val client = ArcadeClient.resource(dbPath)
// write = new ArcadeGraphWriteApi(client)
// query = new ArcadeGraphQueryApi(client)
// bulk  = new ArcadeBulkWriteApi(client)
```

Keep the same Resource pattern — ArcadeClient.resource handles lifecycle.

- [ ] **Step 3: Verify compilation**

Run: `sbt compile`
Expected: Compiles successfully

- [ ] **Step 4: Run full test suite**

Run: `sbt test`
Expected: All non-Arango tests pass. Arango-specific tests may fail (expected — they depend on Docker).

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/Main.scala
git commit -m "feat: wire ArcadeDB as default backend in Main.scala"
```

---

## Chunk 5: Cleanup + Validation

### Task 9: Run existing integration tests against ArcadeDB

**Files:**
- Modify: `memory-layer/src/test/scala/ix/memory/EndToEndSpec.scala`
- Modify: `memory-layer/src/test/scala/ix/memory/ClaimLifecycleSpec.scala`

- [ ] **Step 1: Update EndToEndSpec to use ArcadeClient**

Replace `ArangoClient.resource(...)` with `ArcadeClient.resource(tmpDir)` in test setup.

- [ ] **Step 2: Update ClaimLifecycleSpec to use ArcadeClient**

Same swap.

- [ ] **Step 3: Run integration tests**

Run: `sbt "testOnly ix.memory.EndToEndSpec ix.memory.ClaimLifecycleSpec"`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `sbt test`
Expected: All tests pass (parser tests, model tests, context tests don't touch DB)

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/test/
git commit -m "test: migrate integration tests to ArcadeDB backend"
```

---

### Task 10: Remove ArangoDB dependency

**Files:**
- Modify: `build.sbt`
- Delete: `memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala`
- Delete: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`
- Delete: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphWriteApi.scala`
- Delete: `memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala`
- Delete: `memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`
- Delete: `memory-layer/src/test/scala/ix/memory/db/ArangoClientSpec.scala`
- Delete: `memory-layer/src/test/scala/ix/memory/db/SearchAqlSpec.scala`
- Delete: `docker-compose.yml`
- Delete: `memory-layer/Dockerfile`
- Delete: `scripts/backend.sh`

- [ ] **Step 1: Remove ArangoDB driver from build.sbt**

Remove: `"com.arangodb" % "arangodb-java-driver" % "7.12.0"`

- [ ] **Step 2: Delete Arango implementation files**

Remove all files listed above.

- [ ] **Step 3: Update any remaining references**

Grep for `Arango` in the codebase. Fix any remaining imports or references.

- [ ] **Step 4: Run full test suite**

Run: `sbt test`
Expected: PASS — clean build with no ArangoDB dependency

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove ArangoDB dependency and Docker infrastructure"
```

---

### Task 11: Manual smoke test

- [ ] **Step 1: Build the fat JAR**

Run: `sbt assembly`
Expected: `memory-layer/target/scala-2.13/ix-memory-layer.jar` created

- [ ] **Step 2: Start the server**

Run: `java -jar memory-layer/target/scala-2.13/ix-memory-layer.jar`
Expected: Server starts on port 8090, creates `~/.local/share/ix/data/graph/` directory

- [ ] **Step 3: Test health endpoint**

Run: `curl http://localhost:8090/v1/health`
Expected: `{"status":"ok"}`

- [ ] **Step 4: Test ingestion via CLI**

Run: `ix ingest ./memory-layer/src --recursive`
Expected: Files parsed and ingested successfully

- [ ] **Step 5: Test queries via CLI**

Run: `ix search ContextService --kind class`
Expected: Returns ContextService node

Run: `ix callers commitPatch`
Expected: Returns callers of commitPatch

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in smoke testing"
```
