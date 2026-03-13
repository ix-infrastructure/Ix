package ix.memory.db

import java.nio.file.Files
import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model._

class ArcadeBulkWriteApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def tempDbResource = {
    val tmpDir = Files.createTempDirectory("arcadedb-bulk-test-").toFile.getAbsolutePath
    ArcadeClient.resource(tmpDir)
  }

  private def makePatch(
    filePath: String,
    ops: Vector[PatchOp],
    baseRev: Rev = Rev(0L),
    patchId: PatchId = PatchId(UUID.randomUUID())
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = PatchSource(
        uri        = filePath,
        sourceHash = Some("hash123"),
        extractor  = "test-extractor",
        sourceType = SourceType.Code
      ),
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  private def makeFileBatch(
    filePath: String,
    ops: Vector[PatchOp]
  ): FileBatch = {
    val patch = makePatch(filePath, ops)
    val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
    val provenance = mapper.readValue(
      s"""{"source_uri":"$filePath","source_hash":"hash123","extractor":"test-extractor","source_type":"code","observed_at":"${Instant.now()}"}""",
      classOf[java.util.Map[String, AnyRef]]
    )
    FileBatch(filePath, Some("hash123"), patch, provenance)
  }

  // ── Test 1: commit a batch of patches and verify nodes are queryable ──

  "ArcadeBulkWriteApi" should "commit a batch and insert nodes that are queryable" in {
    tempDbResource.use { client =>
      for {
        _   <- client.ensureSchema()
        api  = new ArcadeBulkWriteApi(client)

        nodeId1 = NodeId(UUID.randomUUID())
        nodeId2 = NodeId(UUID.randomUUID())

        batch1 = makeFileBatch("test/file1.scala", Vector(
          PatchOp.UpsertNode(nodeId1, NodeKind.Function, "funcA", Map("lang" -> Json.fromString("scala")))
        ))
        batch2 = makeFileBatch("test/file2.scala", Vector(
          PatchOp.UpsertNode(nodeId2, NodeKind.Class, "ClassB", Map("lang" -> Json.fromString("scala")))
        ))

        result <- api.commitBatch(Vector(batch1, batch2), 0L)

        // Verify nodes are queryable
        node1 <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId1.value.toString.asInstanceOf[AnyRef])
        )
        node2 <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId2.value.toString.asInstanceOf[AnyRef])
        )

        // Verify revision was updated
        rev <- client.queryOne(
          "SELECT FROM ix_revisions WHERE key = :key",
          Map("key" -> "current".asInstanceOf[AnyRef])
        )
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value shouldBe 1L

        node1 shouldBe defined
        node1.get.hcursor.get[String]("name") shouldBe Right("funcA")
        node1.get.hcursor.get[String]("kind") shouldBe Right("function")

        node2 shouldBe defined
        node2.get.hcursor.get[String]("name") shouldBe Right("ClassB")
        node2.get.hcursor.get[String]("kind") shouldBe Right("class")

        rev shouldBe defined
        rev.get.hcursor.get[Long]("rev") shouldBe Right(1L)
      }
    }
  }

  // ── Test 2: commitBatchChunked with multiple chunks ──

  it should "commitBatchChunked processes multiple chunks with sequential revisions" in {
    tempDbResource.use { client =>
      for {
        _   <- client.ensureSchema()
        api  = new ArcadeBulkWriteApi(client)

        // Create 5 batches, chunk size 2 = 3 chunks (2+2+1)
        batches = (1 to 5).toVector.map { i =>
          val nodeId = NodeId(UUID.randomUUID())
          makeFileBatch(s"test/file$i.scala", Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, s"func$i", Map.empty[String, Json])
          ))
        }

        result <- api.commitBatchChunked(batches, 0L, chunkSize = 2)

        // Should have final rev = 3 (base 0 + 3 chunks)
        allNodes <- client.query(
          "SELECT FROM ix_nodes WHERE deleted_rev IS NULL",
          Map.empty[String, AnyRef]
        )

        rev <- client.queryOne(
          "SELECT FROM ix_revisions WHERE key = :key",
          Map("key" -> "current".asInstanceOf[AnyRef])
        )
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value shouldBe 3L

        allNodes.size shouldBe 5

        rev shouldBe defined
        rev.get.hcursor.get[Long]("rev") shouldBe Right(3L)
      }
    }
  }

  // ── Test 3: batch commit tombstones existing nodes ──

  it should "tombstone existing nodes when re-inserting via batch" in {
    tempDbResource.use { client =>
      for {
        _   <- client.ensureSchema()
        api  = new ArcadeBulkWriteApi(client)

        nodeId = NodeId(UUID.randomUUID())

        // First batch: insert a node
        batch1 = makeFileBatch("test/file1.scala", Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "funcA", Map("version" -> Json.fromString("v1")))
        ))
        _ <- api.commitBatch(Vector(batch1), 0L)

        // Second batch: upsert same node with different attrs
        batch2 = makeFileBatch("test/file1.scala", Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "funcA", Map("version" -> Json.fromString("v2")))
        ))
        result <- api.commitBatch(Vector(batch2), 1L)

        // The old node should be tombstoned
        tombstoned <- client.query(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NOT NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
        // The new node should be live
        live <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value shouldBe 2L
        tombstoned.size shouldBe 1
        live shouldBe defined
        live.get.hcursor.get[Long]("created_rev") shouldBe Right(2L)
      }
    }
  }

  // ── Test 4: batch commit with edges ──

  it should "commit batches with edges" in {
    tempDbResource.use { client =>
      for {
        _   <- client.ensureSchema()
        api  = new ArcadeBulkWriteApi(client)

        nodeId1 = NodeId(UUID.randomUUID())
        nodeId2 = NodeId(UUID.randomUUID())
        edgeId  = EdgeId(UUID.randomUUID())

        batch = makeFileBatch("test/file1.scala", Vector(
          PatchOp.UpsertNode(nodeId1, NodeKind.Function, "caller", Map.empty[String, Json]),
          PatchOp.UpsertNode(nodeId2, NodeKind.Function, "callee", Map.empty[String, Json]),
          PatchOp.UpsertEdge(edgeId, nodeId1, nodeId2, EdgePredicate("CALLS"), Map.empty[String, Json])
        ))

        result <- api.commitBatch(Vector(batch), 0L)

        edge <- client.queryOne(
          "SELECT FROM ix_edges WHERE edge_id = :edgeId",
          Map("edgeId" -> edgeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        result.status shouldBe CommitStatus.Ok
        edge shouldBe defined
        edge.get.hcursor.get[String]("predicate") shouldBe Right("CALLS")
        edge.get.hcursor.get[String]("src") shouldBe Right(nodeId1.value.toString)
        edge.get.hcursor.get[String]("dst") shouldBe Right(nodeId2.value.toString)
      }
    }
  }

  // ── Test 5: empty batch is a no-op ──

  it should "return Ok with same rev for empty batch" in {
    tempDbResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeBulkWriteApi(client)
        result <- api.commitBatchChunked(Vector.empty, 0L)
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value shouldBe 0L
      }
    }
  }
}
