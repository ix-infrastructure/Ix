package ix.memory.context

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.db._
import ix.memory.model._

class ContextServiceSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

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

  private def buildContextService(queryApi: GraphQueryApi): ContextService = {
    val seeder    = new GraphSeeder(queryApi)
    val expander  = new GraphExpander(queryApi)
    val collector = new ClaimCollector(queryApi)
    val scorer    = new ConfidenceScorerImpl()
    val detector  = new ConflictDetectorImpl()
    new ContextService(queryApi, seeder, expander, collector, scorer, detector)
  }

  // ── Test 1: Full pipeline returns structured context ───────────────

  "ContextService" should "return structured context for a query" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)

      val billingId = NodeId(UUID.nameUUIDFromBytes(s"test:billing_service".getBytes))
      val retryId   = NodeId(UUID.nameUUIDFromBytes(s"test:retry_handler".getBytes))
      val edgeId    = EdgeId(UUID.randomUUID())

      val contextService = buildContextService(queryApi)

      val patch = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(billingId, NodeKind.Function, "billing_service", Map.empty[String, Json]),
          PatchOp.UpsertNode(retryId, NodeKind.Function, "retry_handler", Map.empty[String, Json]),
          PatchOp.UpsertEdge(edgeId, billingId, retryId, EdgePredicate("calls"), Map.empty[String, Json]),
          PatchOp.AssertClaim(billingId, "handles_billing", Json.fromString("true"), Some(0.9))
        )
      )

      for {
        _      <- client.ensureSchema()
        _      <- writeApi.commitPatch(patch)
        result <- contextService.query("How does billing retry?")
      } yield {
        result.nodes should not be empty
        result.metadata.query shouldBe "How does billing retry?"
        // seedEntities is List[NodeId] — verify at least 1 seed was found
        result.metadata.seedEntities should not be empty
        result.metadata.hopsExpanded shouldBe 1
      }
    }
  }

  // ── Test 2: Empty context for unknown query ────────────────────────

  it should "return empty context for unknown query" in {
    clientResource.use { client =>
      val queryApi       = new ArangoGraphQueryApi(client)
      val contextService = buildContextService(queryApi)

      for {
        _      <- client.ensureSchema()
        result <- contextService.query("something totally unknown xyz123")
      } yield {
        result.nodes shouldBe empty
        result.claims shouldBe empty
      }
    }
  }

  // ── Test 3: EntityExtractor extracts meaningful terms ──────────────

  it should "extract meaningful terms from queries" in {
    val terms = EntityExtractor.extract("How does billing retry?")
    terms should contain("billing")
    terms should contain("retry")
    terms should not contain ("how")
    terms should not contain ("does")
  }

  // ── Test 4: Claims are scored and ranked ───────────────────────────

  it should "score and rank claims by confidence" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)

      val nodeId = NodeId(UUID.randomUUID())

      val contextService = buildContextService(queryApi)

      val patch = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "billing_func", Map.empty[String, Json]),
          PatchOp.AssertClaim(nodeId, "returns_int", Json.fromString("true"), Some(0.9)),
          PatchOp.AssertClaim(nodeId, "billing_logic", Json.fromString("complex"), Some(0.8))
        )
      )

      for {
        _      <- client.ensureSchema()
        _      <- writeApi.commitPatch(patch)
        result <- contextService.query("What does billing do?")
      } yield {
        result.claims should not be empty
        // All claims should have a score > 0
        result.claims.foreach { sc =>
          sc.confidence.score should be > 0.0
        }
        // Claims should be sorted descending by score
        val scores = result.claims.map(_.confidence.score)
        scores shouldBe scores.sorted.reverse
      }
    }
  }

  // ── Test 5: GraphExpander returns connected nodes ──────────────────

  it should "expand seeds to find connected nodes" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)

      val billingId = NodeId(UUID.randomUUID())
      val retryId   = NodeId(UUID.randomUUID())
      val edgeId    = EdgeId(UUID.randomUUID())

      val contextService = buildContextService(queryApi)

      val patch = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(billingId, NodeKind.Service, "billing_service", Map.empty[String, Json]),
          PatchOp.UpsertNode(retryId, NodeKind.Function, "retry_logic", Map.empty[String, Json]),
          PatchOp.UpsertEdge(edgeId, billingId, retryId, EdgePredicate("calls"), Map.empty[String, Json])
        )
      )

      for {
        _      <- client.ensureSchema()
        _      <- writeApi.commitPatch(patch)
        result <- contextService.query("How does billing work?")
      } yield {
        // Should find billing_service as seed, then expand to find retry_logic
        result.nodes.length should be >= 1
        result.edges should not be empty
      }
    }
  }

  // ── Test 6: No conflicts when only one claim per entity ────────────

  it should "return empty conflicts when no contradictions exist" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)

      val nodeId = NodeId(UUID.randomUUID())
      val contextService = buildContextService(queryApi)

      val patch = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "billing_calc", Map.empty[String, Json]),
          PatchOp.AssertClaim(nodeId, "billing_info", Json.fromString("test"), Some(0.9))
        )
      )

      for {
        _      <- client.ensureSchema()
        _      <- writeApi.commitPatch(patch)
        result <- contextService.query("billing info")
      } yield {
        result.conflicts shouldBe empty
      }
    }
  }

  // ── Test 7: ContextRanker sorts correctly ──────────────────────────

  it should "rank claims in descending confidence order" in {
    val prov = Provenance("test://uri", None, "test", SourceType.Code, Instant.now())
    val claim1 = Claim(ClaimId(UUID.randomUUID()), NodeId(UUID.randomUUID()), "field1",
      ClaimStatus.Active, prov, Rev(1L), None)
    val claim2 = Claim(ClaimId(UUID.randomUUID()), NodeId(UUID.randomUUID()), "field2",
      ClaimStatus.Active, prov, Rev(1L), None)

    val scored1 = ScoredClaim(claim1, ConfidenceBreakdown(
      Factor(0.5, "low"), Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok")
    ))
    val scored2 = ScoredClaim(claim2, ConfidenceBreakdown(
      Factor(0.9, "high"), Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok")
    ))

    val ranked = ContextRanker.rank(Vector(scored1, scored2))
    ranked.head.confidence.score should be > ranked.last.confidence.score
  }
}
