package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.TestDbHelper
import ix.memory.model._

class GraphQueryApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_test_graph_query", user = "root", password = ""
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

  // ── Test 1: getNode should return a committed node ──────────────────

  "GraphQueryApi" should "getNode should return a committed node" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        nodeId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(
              id   = nodeId,
              kind = NodeKind.Function,
              name = "billing_calc",
              attrs = Map("lang" -> Json.fromString("scala"))
            )
          )
        )
        _        <- writeApi.commitPatch(patch)
        result   <- queryApi.getNode(nodeId)
      } yield {
        result shouldBe defined
        val node = result.get
        node.id shouldBe nodeId
        node.kind shouldBe NodeKind.Function
        node.attrs.hcursor.get[String]("lang") shouldBe Right("scala")
        node.provenance.extractor shouldBe "test-extractor"
        node.provenance.sourceType shouldBe SourceType.Code
        node.deletedRev shouldBe None
      }
    }
  }

  // ── Test 2: getNode should respect MVCC visibility ──────────────────

  it should "getNode should respect MVCC visibility" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        nodeId    = NodeId(UUID.randomUUID())
        // Commit patch1: create the node
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
        // Commit patch2: delete the node
        patch2    = makePatch(
          baseRev = rev1,
          ops     = Vector(PatchOp.DeleteNode(nodeId))
        )
        res2     <- writeApi.commitPatch(patch2)
        rev2      = res2.newRev
        // Query as of rev1 → should see the node
        atRev1   <- queryApi.getNode(nodeId, asOfRev = Some(rev1))
        // Query as of rev2 → should not see the node (deleted)
        atRev2   <- queryApi.getNode(nodeId, asOfRev = Some(rev2))
      } yield {
        atRev1 shouldBe defined
        atRev1.get.id shouldBe nodeId
        atRev2 shouldBe None
      }
    }
  }

  // ── Test 3: findNodesByKind should return nodes of given kind ────────

  it should "findNodesByKind should return nodes of given kind" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        funcId1   = NodeId(UUID.randomUUID())
        funcId2   = NodeId(UUID.randomUUID())
        classId   = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(funcId1, NodeKind.Function, "func1", Map.empty[String, Json]),
            PatchOp.UpsertNode(funcId2, NodeKind.Function, "func2", Map.empty[String, Json]),
            PatchOp.UpsertNode(classId, NodeKind.Class, "cls1", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)
        funcs    <- queryApi.findNodesByKind(NodeKind.Function)
        classes  <- queryApi.findNodesByKind(NodeKind.Class)
      } yield {
        funcs.length shouldBe 2
        funcs.map(_.kind).toSet shouldBe Set(NodeKind.Function)
        classes.length shouldBe 1
        classes.head.kind shouldBe NodeKind.Class
      }
    }
  }

  // ── Test 4: expand should return connected nodes and edges ──────────

  it should "expand should return connected nodes and edges" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        nodeA     = NodeId(UUID.randomUUID())
        nodeB     = NodeId(UUID.randomUUID())
        edgeId    = EdgeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeA, NodeKind.Function, "funcA", Map.empty[String, Json]),
            PatchOp.UpsertNode(nodeB, NodeKind.Function, "funcB", Map.empty[String, Json]),
            PatchOp.UpsertEdge(edgeId, nodeA, nodeB, EdgePredicate("calls"), Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)
        outRes   <- queryApi.expand(nodeA, Direction.Out)
        inRes    <- queryApi.expand(nodeB, Direction.In)
        bothRes  <- queryApi.expand(nodeA, Direction.Both)
      } yield {
        // Out from nodeA should find nodeB via "calls" edge
        outRes.edges.length shouldBe 1
        outRes.edges.head.predicate shouldBe EdgePredicate("calls")
        outRes.edges.head.src shouldBe nodeA
        outRes.edges.head.dst shouldBe nodeB
        outRes.nodes.length shouldBe 1
        outRes.nodes.head.id shouldBe nodeB

        // In to nodeB should find nodeA
        inRes.edges.length shouldBe 1
        inRes.nodes.length shouldBe 1
        inRes.nodes.head.id shouldBe nodeA

        // Both from nodeA should also find the edge/node
        bothRes.edges.length shouldBe 1
        bothRes.nodes.length shouldBe 1
      }
    }
  }

  // ── Test 5: searchNodes should find nodes by name ───────────────────

  it should "searchNodes should find nodes by name" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        node1     = NodeId(UUID.randomUUID())
        node2     = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(node1, NodeKind.Service, "billing_service", Map.empty[String, Json]),
            PatchOp.UpsertNode(node2, NodeKind.Service, "payment_gateway", Map.empty[String, Json])
          )
        )
        _        <- writeApi.commitPatch(patch)
        results  <- queryApi.searchNodes("billing")
      } yield {
        results.length shouldBe 1
        results.head.id shouldBe node1
      }
    }
  }

  // ── Test 6: getClaims should return active claims for entity ────────

  it should "getClaims should return active claims for entity" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        nodeId    = NodeId(UUID.randomUUID())
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Function, "myFunc", Map.empty[String, Json]),
            PatchOp.AssertClaim(nodeId, "returns", Json.fromString("Int"), Some(0.9))
          )
        )
        _        <- writeApi.commitPatch(patch)
        claims   <- queryApi.getClaims(nodeId)
      } yield {
        claims.length shouldBe 1
        val claim = claims.head
        claim.entityId shouldBe nodeId
        claim.statement shouldBe "returns"
        claim.status shouldBe ClaimStatus.Active
        claim.provenance.extractor shouldBe "test-extractor"
      }
    }
  }

  // ── Test 7: getLatestRev should return current revision ─────────────

  it should "getLatestRev should return current revision" in {
    clientResource.use { client =>
      for {
        _        <- client.ensureSchema()
        _        <- cleanDatabase(client)
        writeApi  = new ArangoGraphWriteApi(client)
        queryApi  = new ArangoGraphQueryApi(client)
        nodeId    = NodeId(UUID.randomUUID())
        // Before any commits, rev should be 0
        rev0     <- queryApi.getLatestRev
        patch     = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Module, "mod1", Map.empty[String, Json])
          )
        )
        res      <- writeApi.commitPatch(patch)
        rev1     <- queryApi.getLatestRev
      } yield {
        rev0 shouldBe Rev(0L)
        rev1 shouldBe res.newRev
        rev1.value should be > 0L
      }
    }
  }
}
