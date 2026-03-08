package ix.memory

import java.nio.file.{Path, Paths}
import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.context._
import ix.memory.db._
import ix.memory.ingestion.{IngestionService, ParserRouter}
import ix.memory.model._

class EndToEndSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_memory_test", user = "root", password = ""
  )

  private def buildContextService(queryApi: GraphQueryApi): ContextService = {
    val seeder    = new GraphSeeder(queryApi)
    val expander  = new GraphExpander(queryApi)
    val collector = new ClaimCollector(queryApi)
    val scorer    = new ConfidenceScorerImpl()
    val detector  = new ConflictDetectorImpl()
    new ContextService(queryApi, seeder, expander, collector, scorer, detector)
  }

  private def fixtureFilePath: Path = {
    val url = getClass.getClassLoader.getResource("fixtures/sample_project/billing_service.py")
    Paths.get(url.toURI)
  }

  private def makePatch(
    baseRev: Rev = Rev(0L),
    ops: Vector[PatchOp] = Vector.empty,
    patchId: PatchId = PatchId(UUID.randomUUID()),
    source: PatchSource = PatchSource("test://source", Some("hash123"), "test-extractor", SourceType.Code)
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = source,
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  // ── Test 1: Ingest Python code and answer queries with provenance ────

  "EndToEnd" should "ingest Python code and answer queries with provenance" in {
    clientResource.use { client =>
      val writeApi       = new ArangoGraphWriteApi(client)
      val queryApi       = new ArangoGraphQueryApi(client)
      val parserRouter   = new ParserRouter()
      val ingestion      = new IngestionService(parserRouter, writeApi, queryApi)
      val contextService = buildContextService(queryApi)

      for {
        _      <- client.ensureSchema()
        _      <- cleanDatabase(client)
        // Ingest the sample billing_service.py fixture
        commit <- ingestion.ingestFile(fixtureFilePath)
        // Query about billing retry
        result <- contextService.query("How does billing retry?")
      } yield {
        // CommitResult should be Ok
        commit.status shouldBe CommitStatus.Ok
        commit.newRev.value should be > 0L

        // StructuredContext should contain billing-related nodes
        result.nodes should not be empty
        val nodeNames = result.nodes.flatMap { n =>
          n.attrs.hcursor.get[String]("name").toOption
            .orElse(Some(n.id.value.toString))
        }
        // The graph search finds nodes by name containing search terms
        // "billing" should match BillingService or billing_service.py
        result.metadata.query shouldBe "How does billing retry?"
        result.metadata.seedEntities should not be empty
        result.metadata.hopsExpanded shouldBe 1
        result.metadata.asOfRev.value should be > 0L

        // Claims should be present (if any were asserted during ingestion)
        // The parser doesn't generate AssertClaim ops, but nodes and edges are created
        // Verify nodes are present from the ingestion
        result.nodes.size should be >= 1

        // Verify edges are present (CONTAINS, IMPORTS, CALLS relationships)
        result.edges should not be empty
      }
    }
  }

  // ── Test 2: Detect conflicts between contradictory sources ───────────

  it should "detect conflicts between contradictory sources" in {
    clientResource.use { client =>
      val writeApi       = new ArangoGraphWriteApi(client)
      val queryApi       = new ArangoGraphQueryApi(client)
      val parserRouter   = new ParserRouter()
      val ingestion      = new IngestionService(parserRouter, writeApi, queryApi)
      val contextService = buildContextService(queryApi)

      for {
        _         <- client.ensureSchema()
        _         <- cleanDatabase(client)
        // Step 1: Ingest billing_service.py (creates nodes for BillingService etc.)
        commit1   <- ingestion.ingestFile(fixtureFilePath)

        // Compute the deterministic node ID for BillingService
        // (same algorithm as GraphPatchBuilder)
        billingNodeId = NodeId(UUID.nameUUIDFromBytes(
          s"${fixtureFilePath.toString}:BillingService".getBytes("UTF-8")
        ))

        // Step 2: Assert a claim from code source (higher authority)
        // The statement (field) says "uses exponential backoff for retries"
        codePatch = makePatch(
          baseRev = commit1.newRev,
          source = PatchSource("code://billing_service.py", Some("abc"), "tree-sitter", SourceType.Code),
          ops = Vector(
            PatchOp.AssertClaim(billingNodeId, "uses exponential backoff for retries", Json.fromString("true"), Some(0.9))
          )
        )
        commit2 <- writeApi.commitPatch(codePatch)

        // Step 3: Assert a contradictory claim from a README (lower authority)
        // The statement (field) says "does not retry on failure" -- contradicts code
        readmePatch = makePatch(
          baseRev = commit2.newRev,
          source = PatchSource("doc://README.md", Some("def"), "markdown-parser", SourceType.Doc),
          ops = Vector(
            PatchOp.AssertClaim(billingNodeId, "does not retry on failure", Json.fromString("true"), Some(0.7))
          )
        )
        commit3 <- writeApi.commitPatch(readmePatch)

        // Step 4: Query about the topic
        result <- contextService.query("BillingService retry")
      } yield {
        // Both commits should succeed
        commit2.status shouldBe CommitStatus.Ok
        commit3.status shouldBe CommitStatus.Ok

        // Claims should be present
        result.claims should not be empty
        result.claims.size should be >= 2

        // Conflicts should be detected (same entity, different statements)
        result.conflicts should not be empty
        result.conflicts.exists(_.reason.contains("Contradictory statements")) shouldBe true

        // Code-sourced claim should have higher confidence than doc-sourced
        val claimScores = result.claims.map(sc => (sc.claim.provenance.sourceType, sc.confidence.score))
        val codeClaims = result.claims.filter(_.claim.provenance.sourceType == SourceType.Code)
        val docClaims  = result.claims.filter(_.claim.provenance.sourceType == SourceType.Doc)

        if (codeClaims.nonEmpty && docClaims.nonEmpty) {
          codeClaims.head.confidence.score should be > docClaims.head.confidence.score
        }

        // Confidence breakdowns should be explainable
        result.claims.foreach { sc =>
          sc.confidence.baseAuthority.reason should not be empty
          sc.confidence.score should be > 0.0
          sc.confidence.score should be <= 1.0
        }
      }
    }
  }

  // ── Test 3: Support time-travel queries ──────────────────────────────

  it should "support time-travel queries across revisions" in {
    clientResource.use { client =>
      val writeApi       = new ArangoGraphWriteApi(client)
      val queryApi       = new ArangoGraphQueryApi(client)
      val contextService = buildContextService(queryApi)

      // Use deterministic IDs for manual patches
      val coreNodeId    = NodeId(UUID.nameUUIDFromBytes(s"tt:billing_core".getBytes("UTF-8")))
      val newNodeId     = NodeId(UUID.nameUUIDFromBytes(s"tt:payment_processor".getBytes("UTF-8")))
      val edgeId        = EdgeId(UUID.nameUUIDFromBytes(s"tt:billing_core:payment_processor:CALLS".getBytes("UTF-8")))

      for {
        _ <- client.ensureSchema()
        _ <- cleanDatabase(client)

        // Step 1: Commit patch at rev N with billing_core node
        patch1 = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(coreNodeId, NodeKind.Function, "billing_core", Map.empty[String, Json]),
            PatchOp.AssertClaim(coreNodeId, "billing_core_info", Json.fromString("handles billing"), Some(0.9))
          )
        )
        commit1 <- writeApi.commitPatch(patch1)
        revN     = commit1.newRev

        // Step 2: Commit another patch at rev N+1 with a new node + edge
        patch2 = makePatch(
          baseRev = revN,
          ops = Vector(
            PatchOp.UpsertNode(newNodeId, NodeKind.Function, "payment_processor", Map.empty[String, Json]),
            PatchOp.UpsertEdge(edgeId, coreNodeId, newNodeId, EdgePredicate("CALLS"), Map.empty[String, Json]),
            PatchOp.AssertClaim(newNodeId, "payment_info", Json.fromString("processes payments"), Some(0.85))
          )
        )
        commit2 <- writeApi.commitPatch(patch2)
        revN1    = commit2.newRev

        // Step 3: Verify revisions advanced
        _ = {
          revN1.value shouldBe revN.value + 1
        }

        // Step 4: Query at revN -- should only see billing_core node
        // The node payment_processor was created at revN+1 so it should NOT appear
        // in the expansion (expand filters by created_rev <= asOfRev)
        resultAtRevN <- contextService.query("billing_core", asOfRev = Some(revN))

        // Step 5: Query at latest -- should see both nodes
        resultLatest <- contextService.query("billing_core")
      } yield {
        // At revN: only billing_core should be found, payment_processor should NOT
        // appear in the expanded nodes
        val oldNodeNames = resultAtRevN.nodes.map(_.id)
        oldNodeNames should contain(coreNodeId)
        // payment_processor was created at revN+1, so expand should not find it
        val expandedNodeIdsAtRevN = resultAtRevN.edges.flatMap(e => List(e.src, e.dst))
        expandedNodeIdsAtRevN should not contain newNodeId

        // At latest: both nodes should be visible
        val latestNodeIds = resultLatest.nodes.map(_.id)
        latestNodeIds should contain(coreNodeId)
        // The expanded result should include payment_processor via the edge
        val allLatestIds = resultLatest.nodes.map(_.id) ++ resultLatest.edges.flatMap(e => List(e.src, e.dst))
        allLatestIds should contain(newNodeId)

        // Metadata should reflect the requested revision
        resultAtRevN.metadata.asOfRev shouldBe revN
      }
    }
  }

  // ── Test 4: Idempotent re-ingestion ──────────────────────────────────

  it should "be idempotent when re-ingesting the same file" in {
    clientResource.use { client =>
      val writeApi     = new ArangoGraphWriteApi(client)
      val queryApi     = new ArangoGraphQueryApi(client)
      val parserRouter = new ParserRouter()
      val ingestion    = new IngestionService(parserRouter, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- cleanDatabase(client)

        // Step 1: First ingestion
        commit1 <- ingestion.ingestFile(fixtureFilePath)

        // Count nodes after first ingestion
        nodesBefore <- queryApi.findNodesByKind(NodeKind.Class)
        funcsBefore <- queryApi.findNodesByKind(NodeKind.Function)
        totalBefore  = nodesBefore.size + funcsBefore.size

        // Step 2: Re-ingest the same file with the same content — should be skipped (idempotent)
        result2 <- ingestion.ingestFile(fixtureFilePath).attempt

        // Count nodes after second ingestion
        nodesAfter <- queryApi.findNodesByKind(NodeKind.Class)
        funcsAfter <- queryApi.findNodesByKind(NodeKind.Function)
        totalAfter  = nodesAfter.size + funcsAfter.size
      } yield {
        // First ingestion should succeed
        commit1.status shouldBe CommitStatus.Ok

        // Second ingestion should be skipped — hash unchanged
        result2.isLeft shouldBe true
        result2.left.exists(_.getMessage.startsWith("Idempotent")) shouldBe true

        // Node count should NOT increase
        totalAfter shouldBe totalBefore

        // The nodes should have the same IDs (deterministic UUID generation)
        nodesBefore.map(_.id).toSet shouldBe nodesAfter.map(_.id).toSet
        funcsBefore.map(_.id).toSet shouldBe funcsAfter.map(_.id).toSet
      }
    }
  }
}
