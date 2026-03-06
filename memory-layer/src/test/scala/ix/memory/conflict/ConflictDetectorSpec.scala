package ix.memory.conflict

import java.time.Instant
import java.util.UUID
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.Json
import ix.memory.model._
import ix.memory.context.ConflictDetectorImpl

class ConflictDetectorSpec extends AnyFlatSpec with Matchers {
  val detector = new ConflictDetectorImpl()

  private def makeScoredClaim(entityId: NodeId, statement: String,
                               score: Double, sourceType: SourceType = SourceType.Code): ScoredClaim = {
    val claim = Claim(
      id = ClaimId(UUID.randomUUID()),
      entityId = entityId,
      statement = statement,
      value = Json.Null,
      confidence = None,
      status = ClaimStatus.Active,
      provenance = Provenance("test.py", Some("abc"), "test", sourceType, Instant.now()),
      createdRev = Rev(1L),
      deletedRev = None
    )
    val breakdown = ConfidenceBreakdown(
      baseAuthority = Factor(score, "test"),
      verification = Factor(1.0, "test"),
      recency = Factor(1.0, "test"),
      corroboration = Factor(1.0, "test"),
      conflictPenalty = Factor(1.0, "test"),
      intentAlignment = Factor(1.0, "test")
    )
    ScoredClaim(claim, breakdown)
  }

  "ConflictDetector" should "detect conflicting claims on same entity" in {
    val entityId = NodeId(UUID.randomUUID())
    val claim1 = makeScoredClaim(entityId, "returns String", 0.90)
    val claim2 = makeScoredClaim(entityId, "returns Int", 0.75)

    val conflicts = detector.detect(Vector(claim1, claim2))

    conflicts.size shouldBe 1
    conflicts.head.reason should include("Contradictory")
    conflicts.head.recommendation should include("returns String")
  }

  it should "not flag claims on different entities" in {
    val entity1 = NodeId(UUID.randomUUID())
    val entity2 = NodeId(UUID.randomUUID())
    val claim1 = makeScoredClaim(entity1, "returns String", 0.90)
    val claim2 = makeScoredClaim(entity2, "returns Int", 0.75)

    val conflicts = detector.detect(Vector(claim1, claim2))

    conflicts shouldBe empty
  }

  it should "not flag claims with the same statement" in {
    val entityId = NodeId(UUID.randomUUID())
    val claim1 = makeScoredClaim(entityId, "returns String", 0.90)
    val claim2 = makeScoredClaim(entityId, "returns String", 0.85)

    val conflicts = detector.detect(Vector(claim1, claim2))

    conflicts shouldBe empty
  }

  it should "recommend the higher-confidence claim" in {
    val entityId = NodeId(UUID.randomUUID())
    val highConf = makeScoredClaim(entityId, "returns String", 0.95)
    val lowConf = makeScoredClaim(entityId, "returns Int", 0.40)

    val conflicts = detector.detect(Vector(highConf, lowConf))

    conflicts.head.recommendation should include("returns String")
    conflicts.head.recommendation should include("0.95")
  }

  it should "detect multiple conflicts in a group" in {
    val entityId = NodeId(UUID.randomUUID())
    val claim1 = makeScoredClaim(entityId, "returns String", 0.90)
    val claim2 = makeScoredClaim(entityId, "returns Int", 0.75)
    val claim3 = makeScoredClaim(entityId, "returns Boolean", 0.60)

    val conflicts = detector.detect(Vector(claim1, claim2, claim3))

    conflicts.size shouldBe 3  // 3 pairs from 3 different statements
  }

  it should "ignore retracted claims" in {
    val entityId = NodeId(UUID.randomUUID())
    val activeClaim = makeScoredClaim(entityId, "returns String", 0.90)
    val retractedClaim = {
      val sc = makeScoredClaim(entityId, "returns Int", 0.75)
      sc.copy(claim = sc.claim.copy(status = ClaimStatus.Retracted))
    }

    val conflicts = detector.detect(Vector(activeClaim, retractedClaim))

    conflicts shouldBe empty
  }

  it should "return empty for single claim" in {
    val entityId = NodeId(UUID.randomUUID())
    val claim = makeScoredClaim(entityId, "returns String", 0.90)

    val conflicts = detector.detect(Vector(claim))

    conflicts shouldBe empty
  }

  it should "return empty for empty input" in {
    val conflicts = detector.detect(Vector.empty)

    conflicts shouldBe empty
  }
}
