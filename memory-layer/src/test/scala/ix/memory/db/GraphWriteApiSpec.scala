package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model._

class GraphWriteApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_memory_test", user = "root", password = ""
  )

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

  // ── Test 1: commit a patch and increment revision ──────────────────

  "GraphWriteApi" should "commit a patch and increment revision" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArangoGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        patch   = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId,
              kind = NodeKind.Function,
              name = "testFunc",
              attrs = Map("lang" -> Json.fromString("scala"))
            )
          )
        )
        result <- api.commitPatch(patch)
      } yield {
        result.status shouldBe CommitStatus.Ok
        result.newRev.value should be > 0L
      }
    }
  }

  // ── Test 2: be idempotent on duplicate patch_id ────────────────────

  it should "be idempotent on duplicate patch_id" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArangoGraphWriteApi(client)
        nodeId   = NodeId(UUID.randomUUID())
        patchId  = PatchId(UUID.randomUUID())
        patch    = makePatch(
          patchId = patchId,
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId,
              kind = NodeKind.Module,
              name = "testModule",
              attrs = Map.empty[String, Json]
            )
          )
        )
        result1 <- api.commitPatch(patch)
        result2 <- api.commitPatch(patch)
      } yield {
        result1.status shouldBe CommitStatus.Ok
        result2.status shouldBe CommitStatus.Idempotent
        result2.newRev shouldBe result1.newRev
      }
    }
  }

  // ── Test 3: reject on base_rev mismatch ────────────────────────────

  it should "reject on base_rev mismatch" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArangoGraphWriteApi(client)
        nodeId1  = NodeId(UUID.randomUUID())
        // First patch to establish rev 1
        patch1   = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId1,
              kind = NodeKind.Service,
              name = "svc1",
              attrs = Map.empty[String, Json]
            )
          )
        )
        _       <- api.commitPatch(patch1)
        // Second patch with wrong baseRev
        nodeId2  = NodeId(UUID.randomUUID())
        patch2   = makePatch(
          baseRev = Rev(999L),
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId2,
              kind = NodeKind.Service,
              name = "svc2",
              attrs = Map.empty[String, Json]
            )
          )
        )
        result  <- api.commitPatch(patch2)
      } yield {
        result.status shouldBe CommitStatus.BaseRevMismatch
      }
    }
  }

  // ── Test 4: persist node visible via query ─────────────────────────

  it should "persist node visible via query" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArangoGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        patch   = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id    = nodeId,
              kind  = NodeKind.File,
              name  = "Main.scala",
              attrs = Map("path" -> Json.fromString("/src/Main.scala"))
            )
          )
        )
        _      <- api.commitPatch(patch)
        result <- client.queryOne(
          "FOR n IN nodes FILTER n._key == @key RETURN n",
          Map("key" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        result shouldBe defined
        val doc = result.get
        doc.hcursor.get[String]("kind") shouldBe Right("file")
        doc.hcursor.get[String]("name") shouldBe Right("Main.scala")
        // attrs should contain the path attribute
        doc.hcursor.downField("attrs").downField("path").as[String] shouldBe Right("/src/Main.scala")
        // deleted_rev should be null (not soft-deleted)
        doc.hcursor.get[Option[Long]]("deleted_rev") shouldBe Right(None)
      }
    }
  }

  // ── Test 5: soft delete node via MVCC ──────────────────────────────

  it should "soft delete node via MVCC" in {
    clientResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArangoGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
        // First patch: create the node
        patch1  = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId,
              kind = NodeKind.Class,
              name = "MyClass",
              attrs = Map.empty[String, Json]
            )
          )
        )
        res1   <- api.commitPatch(patch1)
        // Second patch: soft delete the node
        patch2  = makePatch(
          baseRev = res1.newRev,
          ops     = Vector(PatchOp.DeleteNode(nodeId))
        )
        res2   <- api.commitPatch(patch2)
        // Query the node to verify soft delete
        result <- client.queryOne(
          "FOR n IN nodes FILTER n._key == @key RETURN n",
          Map("key" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        res1.status shouldBe CommitStatus.Ok
        res2.status shouldBe CommitStatus.Ok
        res2.newRev.value shouldBe res1.newRev.value + 1

        result shouldBe defined
        val doc = result.get
        doc.hcursor.get[Long]("deleted_rev") shouldBe Right(res2.newRev.value)
      }
    }
  }
}
