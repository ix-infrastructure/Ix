package ix.memory.context

import java.time.Instant
import java.util.UUID

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model._

class RelevanceScorerSpec extends AnyFlatSpec with Matchers {

  private val prov = Provenance("test://uri", None, "test", SourceType.Code, Instant.now())
  private val defaultBreakdown = ConfidenceBreakdown(
    Factor(0.8, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok"),
    Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok")
  )

  private def makeClaim(entityId: NodeId): ScoredClaim = {
    val claim = Claim(
      ClaimId(UUID.randomUUID()), entityId, "test_field",
      io.circe.Json.Null, None, ClaimStatus.Active, prov, Rev(1L), None
    )
    ScoredClaim(claim, defaultBreakdown, relevance = 1.0, finalScore = defaultBreakdown.score)
  }

  "RelevanceScorer" should "assign relevance 1.0 to seed node claims" in {
    val seedId = NodeId(UUID.randomUUID())
    val claims = Vector(makeClaim(seedId))
    val result = RelevanceScorer.score(claims, Set(seedId), Vector.empty)
    result.head.relevance shouldBe 1.0
    result.head.finalScore shouldBe (1.0 * defaultBreakdown.score)
  }

  it should "assign relevance 0.7 to one-hop node claims" in {
    val seedId = NodeId(UUID.randomUUID())
    val oneHopId = NodeId(UUID.randomUUID())
    val edge = GraphEdge(
      id = EdgeId(UUID.randomUUID()),
      src = seedId, dst = oneHopId,
      predicate = EdgePredicate("calls"),
      attrs = io.circe.Json.obj(),
      provenance = prov,
      createdRev = Rev(1L), deletedRev = None
    )
    val claims = Vector(makeClaim(oneHopId))
    val result = RelevanceScorer.score(claims, Set(seedId), Vector(edge))
    result.head.relevance shouldBe 0.7
    result.head.finalScore shouldBe (0.7 * defaultBreakdown.score +- 0.001)
  }

  it should "assign relevance 0.4 to two-hop-plus node claims" in {
    val seedId = NodeId(UUID.randomUUID())
    val farId = NodeId(UUID.randomUUID())
    val claims = Vector(makeClaim(farId))
    val result = RelevanceScorer.score(claims, Set(seedId), Vector.empty)
    result.head.relevance shouldBe 0.4
    result.head.finalScore shouldBe (0.4 * defaultBreakdown.score +- 0.001)
  }

  it should "handle mixed claims correctly" in {
    val seedId = NodeId(UUID.randomUUID())
    val oneHopId = NodeId(UUID.randomUUID())
    val farId = NodeId(UUID.randomUUID())
    val edge = GraphEdge(
      id = EdgeId(UUID.randomUUID()),
      src = seedId, dst = oneHopId,
      predicate = EdgePredicate("calls"),
      attrs = io.circe.Json.obj(),
      provenance = prov,
      createdRev = Rev(1L), deletedRev = None
    )
    val claims = Vector(makeClaim(seedId), makeClaim(oneHopId), makeClaim(farId))
    val result = RelevanceScorer.score(claims, Set(seedId), Vector(edge))

    result(0).relevance shouldBe 1.0
    result(1).relevance shouldBe 0.7
    result(2).relevance shouldBe 0.4
  }
}
