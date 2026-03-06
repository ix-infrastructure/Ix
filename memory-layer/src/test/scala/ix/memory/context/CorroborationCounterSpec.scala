package ix.memory.context

import java.time.Instant
import java.util.UUID

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import io.circe.Json
import ix.memory.model._

class CorroborationCounterSpec extends AnyFlatSpec with Matchers {

  private def makeClaim(entityId: NodeId, statement: String, sourceUri: String): Claim =
    Claim(
      id         = ClaimId(UUID.randomUUID()),
      entityId   = entityId,
      statement  = statement,
      value      = Json.Null,
      confidence = None,
      status     = ClaimStatus.Active,
      provenance = Provenance(sourceUri, None, "test", SourceType.Code, Instant.now()),
      createdRev = Rev(1L),
      deletedRev = None
    )

  val entityA = NodeId(UUID.randomUUID())
  val entityB = NodeId(UUID.randomUUID())

  // Test 1: Single claim — no corroboration
  "CorroborationCounter" should "return 0 for a single claim" in {
    val claim = makeClaim(entityA, "handles billing", "src/billing.py")
    val counts = CorroborationCounter.count(Vector(claim))
    counts(claim.id) shouldBe 0
  }

  // Test 2: Two claims, same entity, same topic, different sources — corroborate
  it should "count corroborating claims from independent sources" in {
    val c1 = makeClaim(entityA, "handles billing logic", "src/billing.py")
    val c2 = makeClaim(entityA, "billing handler function", "docs/api.md")
    val counts = CorroborationCounter.count(Vector(c1, c2))
    counts(c1.id) shouldBe 1
    counts(c2.id) shouldBe 1
  }

  // Test 3: Two claims, same entity, same source — NOT corroborating
  it should "not count claims from the same source" in {
    val c1 = makeClaim(entityA, "handles billing logic", "src/billing.py")
    val c2 = makeClaim(entityA, "billing handler function", "src/billing.py")
    val counts = CorroborationCounter.count(Vector(c1, c2))
    counts(c1.id) shouldBe 0
    counts(c2.id) shouldBe 0
  }

  // Test 4: Two claims, different entities — NOT corroborating
  it should "not count claims on different entities" in {
    val c1 = makeClaim(entityA, "handles billing logic", "src/billing.py")
    val c2 = makeClaim(entityB, "handles billing logic", "docs/api.md")
    val counts = CorroborationCounter.count(Vector(c1, c2))
    counts(c1.id) shouldBe 0
    counts(c2.id) shouldBe 0
  }

  // Test 5: Two claims, same entity, no keyword overlap — NOT corroborating
  it should "not count claims with no keyword overlap" in {
    val c1 = makeClaim(entityA, "handles billing logic", "src/billing.py")
    val c2 = makeClaim(entityA, "returns integer value", "docs/api.md")
    val counts = CorroborationCounter.count(Vector(c1, c2))
    counts(c1.id) shouldBe 0
    counts(c2.id) shouldBe 0
  }

  // Test 6: Three claims corroborating
  it should "count multiple corroborating sources" in {
    val c1 = makeClaim(entityA, "billing service handler", "src/billing.py")
    val c2 = makeClaim(entityA, "billing api handler", "docs/billing.md")
    val c3 = makeClaim(entityA, "handles billing requests", "test/billing_test.py")
    val counts = CorroborationCounter.count(Vector(c1, c2, c3))
    // c1 should be corroborated by c2 and c3 (all share "bill" stem)
    counts(c1.id) shouldBe 2
    counts(c2.id) shouldBe 2
    counts(c3.id) shouldBe 2
  }

  // Test 7: Empty claims vector
  it should "return empty map for no claims" in {
    val counts = CorroborationCounter.count(Vector.empty)
    counts shouldBe empty
  }
}
