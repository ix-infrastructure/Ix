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

class ArcadeGraphQueryApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def tempDbResource = {
    val tmpDir = Files.createTempDirectory("arcadedb-query-test-").toFile.getAbsolutePath
    ArcadeClient.resource(tmpDir)
  }

  private def makePatch(
    baseRev: Rev = Rev(0L),
    ops: Vector[PatchOp] = Vector.empty,
    patchId: PatchId = PatchId(UUID.randomUUID()),
    sourceUri: String = "test://source",
    extractor: String = "test-extractor",
    sourceHash: Option[String] = Some("hash123"),
    sourceType: SourceType = SourceType.Code
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = PatchSource(
        uri        = sourceUri,
        sourceHash = sourceHash,
        extractor  = extractor,
        sourceType = sourceType
      ),
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  // ── Test 1: getNode returns a committed node ───────────────────────

  "ArcadeGraphQueryApi" should "getNode returns a committed node" in {
    tempDbResource.use { client =>
      for {
        _       <- client.ensureSchema()
        writeApi = new ArcadeGraphWriteApi(client)
        queryApi = new ArcadeGraphQueryApi(client)
        nodeId   = NodeId(UUID.randomUUID())
        patch    = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id    = nodeId,
              kind  = NodeKind.Function,
              name  = "myFunc",
              attrs = Map("lang" -> Json.fromString("scala"))
            )
          )
        )
        _      <- writeApi.commitPatch(patch)
        result <- queryApi.getNode(nodeId)
      } yield {
        result shouldBe defined
        val node = result.get
        node.id shouldBe nodeId
        node.kind shouldBe NodeKind.Function
        node.name shouldBe "myFunc"
        node.createdRev.value should be > 0L
        node.deletedRev shouldBe None
      }
    }
  }

  // ── Test 2: getNode respects MVCC visibility ───────────────────────

  it should "getNode respects MVCC visibility" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)
        nodeId    = NodeId(UUID.randomUUID())

        // Create node at rev 1
        patch1    = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId,
              kind = NodeKind.Class,
              name = "MyClass",
              attrs = Map.empty[String, Json]
            )
          )
        )
        res1     <- writeApi.commitPatch(patch1)
        rev1      = res1.newRev

        // Delete node at rev 2
        patch2    = makePatch(
          baseRev = rev1,
          ops     = Vector(PatchOp.DeleteNode(nodeId))
        )
        res2     <- writeApi.commitPatch(patch2)
        rev2      = res2.newRev

        // Query at rev 1: should be visible
        atRev1   <- queryApi.getNode(nodeId, asOfRev = Some(rev1))
        // Query at rev 2: should be gone
        atRev2   <- queryApi.getNode(nodeId, asOfRev = Some(rev2))
        // Query at rev 0: should not exist yet
        atRev0   <- queryApi.getNode(nodeId, asOfRev = Some(Rev(0L)))
      } yield {
        atRev1 shouldBe defined
        atRev1.get.name shouldBe "MyClass"
        atRev2 shouldBe None
        atRev0 shouldBe None
      }
    }
  }

  // ── Test 3: findNodesByKind returns nodes of given kind ────────────

  it should "findNodesByKind returns nodes of given kind" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        funcId    = NodeId(UUID.randomUUID())
        classId   = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(funcId, NodeKind.Function, "func1", Map.empty[String, Json]),
            PatchOp.UpsertNode(classId, NodeKind.Class, "class1", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        funcs    <- queryApi.findNodesByKind(NodeKind.Function)
        classes  <- queryApi.findNodesByKind(NodeKind.Class)
      } yield {
        funcs.size shouldBe 1
        funcs.head.name shouldBe "func1"
        classes.size shouldBe 1
        classes.head.name shouldBe "class1"
      }
    }
  }

  // ── Test 4: expand returns connected nodes and edges ───────────────

  it should "expand returns connected nodes and edges" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        srcId     = NodeId(UUID.randomUUID())
        dstId     = NodeId(UUID.randomUUID())
        edgeId    = EdgeId(UUID.randomUUID())

        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(srcId, NodeKind.Class, "Parent", Map.empty[String, Json]),
            PatchOp.UpsertNode(dstId, NodeKind.Function, "child", Map.empty[String, Json]),
            PatchOp.UpsertEdge(edgeId, srcId, dstId, EdgePredicate("CONTAINS"), Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        // Expand outward from Parent
        outResult <- queryApi.expand(srcId, Direction.Out)
        // Expand inward from child
        inResult  <- queryApi.expand(dstId, Direction.In)
        // Expand both from Parent
        bothResult <- queryApi.expand(srcId, Direction.Both)
      } yield {
        outResult.edges.size shouldBe 1
        outResult.edges.head.predicate shouldBe EdgePredicate("CONTAINS")
        outResult.nodes.size shouldBe 1
        outResult.nodes.head.name shouldBe "child"

        inResult.edges.size shouldBe 1
        inResult.nodes.size shouldBe 1
        inResult.nodes.head.name shouldBe "Parent"

        bothResult.edges.size shouldBe 1
        bothResult.nodes.size shouldBe 1
      }
    }
  }

  // ── Test 5: searchNodes finds nodes by name ────────────────────────

  it should "searchNodes finds nodes by name" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        id1       = NodeId(UUID.randomUUID())
        id2       = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(id1, NodeKind.Function, "processPayment", Map.empty[String, Json]),
            PatchOp.UpsertNode(id2, NodeKind.Class, "PaymentService", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        results  <- queryApi.searchNodes("Payment")
      } yield {
        results.size shouldBe 2
        results.map(_.name).toSet shouldBe Set("processPayment", "PaymentService")
      }
    }
  }

  // ── Test 6: getClaims returns active claims for entity ─────────────

  it should "getClaims returns active claims for entity" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        nodeId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, "verify", Map.empty[String, Json]),
            PatchOp.AssertClaim(nodeId, "returns", Json.fromString("Boolean"), Some(0.9))
          )
        )
        _        <- writeApi.commitPatch(patch)

        claims   <- queryApi.getClaims(nodeId)
      } yield {
        claims.size shouldBe 1
        claims.head.entityId shouldBe nodeId
        claims.head.statement shouldBe "returns"
        claims.head.status shouldBe ClaimStatus.Active
      }
    }
  }

  // ── Test 7: getLatestRev returns current revision ──────────────────

  it should "getLatestRev returns current revision" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        // Before any commits, rev should be 0
        rev0     <- queryApi.getLatestRev

        nodeId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Module, "mod1", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)
        rev1     <- queryApi.getLatestRev

        nodeId2   = NodeId(UUID.randomUUID())
        patch2    = makePatch(
          baseRev = rev1,
          ops = Vector(
            PatchOp.UpsertNode(nodeId2, NodeKind.Module, "mod2", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch2)
        rev2     <- queryApi.getLatestRev
      } yield {
        rev0 shouldBe Rev(0L)
        rev1 shouldBe Rev(1L)
        rev2 shouldBe Rev(2L)
      }
    }
  }

  // ── Test 8: resolvePrefix finds nodes by UUID prefix ───────────────

  it should "resolvePrefix finds nodes by UUID prefix" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        nodeId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, "testFunc", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        // Use first 8 chars of UUID as prefix
        prefix    = nodeId.value.toString.take(8)
        results  <- queryApi.resolvePrefix(prefix)
      } yield {
        results should contain(nodeId)
      }
    }
  }

  // ── Test 9: listDecisions returns decision nodes ───────────────────

  it should "listDecisions returns decision nodes" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        decId     = NodeId(UUID.randomUUID())
        funcId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(decId, NodeKind.Decision, "Use PostgreSQL",
              Map("title" -> Json.fromString("Use PostgreSQL"), "rationale" -> Json.fromString("Better for ACID compliance"))),
            PatchOp.UpsertNode(funcId, NodeKind.Function, "notADecision", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        allDecs  <- queryApi.listDecisions()
        filtered <- queryApi.listDecisions(topic = Some("PostgreSQL"))
        noMatch  <- queryApi.listDecisions(topic = Some("MongoDB"))
      } yield {
        allDecs.size shouldBe 1
        allDecs.head.name shouldBe "Use PostgreSQL"
        allDecs.head.kind shouldBe NodeKind.Decision

        filtered.size shouldBe 1
        noMatch.size shouldBe 0
      }
    }
  }

  // ── Test 10: expand with predicate filter ──────────────────────────

  it should "expand with predicate filter" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        srcId     = NodeId(UUID.randomUUID())
        dst1Id    = NodeId(UUID.randomUUID())
        dst2Id    = NodeId(UUID.randomUUID())
        edge1Id   = EdgeId(UUID.randomUUID())
        edge2Id   = EdgeId(UUID.randomUUID())

        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(srcId, NodeKind.Class, "MyClass", Map.empty[String, Json]),
            PatchOp.UpsertNode(dst1Id, NodeKind.Function, "method1", Map.empty[String, Json]),
            PatchOp.UpsertNode(dst2Id, NodeKind.Class, "OtherClass", Map.empty[String, Json]),
            PatchOp.UpsertEdge(edge1Id, srcId, dst1Id, EdgePredicate("CONTAINS"), Map.empty[String, Json]),
            PatchOp.UpsertEdge(edge2Id, srcId, dst2Id, EdgePredicate("IMPORTS"), Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        // Expand with only CONTAINS predicate
        containsResult <- queryApi.expand(srcId, Direction.Out, predicates = Some(Set("CONTAINS")))
        // Expand with only IMPORTS predicate
        importsResult  <- queryApi.expand(srcId, Direction.Out, predicates = Some(Set("IMPORTS")))
      } yield {
        containsResult.edges.size shouldBe 1
        containsResult.edges.head.predicate shouldBe EdgePredicate("CONTAINS")
        containsResult.nodes.head.name shouldBe "method1"

        importsResult.edges.size shouldBe 1
        importsResult.edges.head.predicate shouldBe EdgePredicate("IMPORTS")
        importsResult.nodes.head.name shouldBe "OtherClass"
      }
    }
  }

  // ── Test 11: expandByName ──────────────────────────────────────────

  it should "expandByName finds edges by node name" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        srcId     = NodeId(UUID.randomUUID())
        dstId     = NodeId(UUID.randomUUID())
        edgeId    = EdgeId(UUID.randomUUID())

        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(srcId, NodeKind.Class, "AuthService", Map.empty[String, Json]),
            PatchOp.UpsertNode(dstId, NodeKind.Function, "verifyToken", Map.empty[String, Json]),
            PatchOp.UpsertEdge(edgeId, srcId, dstId, EdgePredicate("CONTAINS"), Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        result   <- queryApi.expandByName("AuthService", Direction.Out)
      } yield {
        result.edges.size shouldBe 1
        result.nodes.size shouldBe 1
        result.nodes.head.name shouldBe "verifyToken"
      }
    }
  }

  // ── Test 12: getDiffSummary ────────────────────────────────────────

  it should "getDiffSummary returns change counts" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        nodeId    = NodeId(UUID.randomUUID())
        patch1    = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, "func1", Map.empty[String, Json])
          )
        )
        res1     <- writeApi.commitPatch(patch1)

        summary  <- queryApi.getDiffSummary(Rev(0L), res1.newRev)
      } yield {
        summary.get("added") shouldBe Some(1)
      }
    }
  }

  // ── Test 13: getChangedEntities ────────────────────────────────────

  it should "getChangedEntities returns changed nodes" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        nodeId    = NodeId(UUID.randomUUID())
        patch1    = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, "func1",
              Map("lang" -> Json.fromString("scala")))
          )
        )
        res1     <- writeApi.commitPatch(patch1)

        changes  <- queryApi.getChangedEntities(Rev(0L), res1.newRev)
      } yield {
        changes.size shouldBe 1
        val (current, prev) = changes.head
        current.name shouldBe "func1"
        prev shouldBe None  // didn't exist before
      }
    }
  }

  // ── Test 14: searchNodes with nameOnly mode ────────────────────────

  it should "searchNodes with nameOnly mode" in {
    tempDbResource.use { client =>
      for {
        _        <- client.ensureSchema()
        writeApi  = new ArcadeGraphWriteApi(client)
        queryApi  = new ArcadeGraphQueryApi(client)

        id1       = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(id1, NodeKind.Function, "processPayment", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)

        results  <- queryApi.searchNodes("process", nameOnly = true)
      } yield {
        results.size shouldBe 1
        results.head.name shouldBe "processPayment"
      }
    }
  }
}
