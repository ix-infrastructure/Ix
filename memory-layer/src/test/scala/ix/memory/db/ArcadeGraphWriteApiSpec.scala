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

class ArcadeGraphWriteApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def tempDbResource = {
    val tmpDir = Files.createTempDirectory("arcadedb-write-test-").toFile.getAbsolutePath
    ArcadeClient.resource(tmpDir)
  }

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

  "ArcadeGraphWriteApi" should "commit a patch and increment revision" in {
    tempDbResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
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
    tempDbResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArcadeGraphWriteApi(client)
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
    tempDbResource.use { client =>
      for {
        _       <- client.ensureSchema()
        api      = new ArcadeGraphWriteApi(client)
        nodeId1  = NodeId(UUID.randomUUID())
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
    tempDbResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
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
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        result shouldBe defined
        val doc = result.get
        doc.hcursor.get[String]("kind") shouldBe Right("file")
        doc.hcursor.get[String]("name") shouldBe Right("Main.scala")
      }
    }
  }

  // ── Test 5: soft delete node via MVCC ──────────────────────────────

  it should "soft delete node via MVCC" in {
    tempDbResource.use { client =>
      for {
        _      <- client.ensureSchema()
        api     = new ArcadeGraphWriteApi(client)
        nodeId  = NodeId(UUID.randomUUID())
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
        patch2  = makePatch(
          baseRev = res1.newRev,
          ops     = Vector(PatchOp.DeleteNode(nodeId))
        )
        res2   <- api.commitPatch(patch2)
        // The live query should return nothing
        live   <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
        // The tombstoned query should find it
        dead   <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :id AND deleted_rev IS NOT NULL",
          Map("id" -> nodeId.value.toString.asInstanceOf[AnyRef])
        )
      } yield {
        res1.status shouldBe CommitStatus.Ok
        res2.status shouldBe CommitStatus.Ok
        res2.newRev.value shouldBe res1.newRev.value + 1
        live shouldBe None
        dead shouldBe defined
        dead.get.hcursor.get[Long]("deleted_rev") shouldBe Right(res2.newRev.value)
      }
    }
  }
}
