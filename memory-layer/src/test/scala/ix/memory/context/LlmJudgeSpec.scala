package ix.memory.context

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import io.circe.Json
import ix.memory.model._

class LlmJudgeSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def makeScoredClaim(statement: String, entityId: NodeId, score: Double = 0.8): ScoredClaim = {
    val claim = Claim(
      ClaimId(UUID.randomUUID()), entityId, statement,
      Json.Null, None, ClaimStatus.Active,
      Provenance("test://src", None, "test", SourceType.Code, Instant.now()),
      Rev(1L), None
    )
    ScoredClaim(claim, ConfidenceBreakdown(
      Factor(score, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok"),
      Factor(1.0, "ok"), Factor(1.0, "ok"), Factor(1.0, "ok")
    ), relevance = 1.0, finalScore = score)
  }

  val entityId: NodeId = NodeId(UUID.randomUUID())

  // Test 1: StubLlmJudge returns None
  "StubLlmJudge" should "always return None" in {
    val judge = new StubLlmJudge()
    val c1 = makeScoredClaim("handles billing", entityId).claim
    val c2 = makeScoredClaim("does not handle billing", entityId).claim
    judge.judge(c1, c2).asserting(_ shouldBe None)
  }

  // Test 2: ConflictDetectorImpl without LLM — refineWithLlm returns conflicts unchanged
  "ConflictDetectorImpl" should "return conflicts unchanged when no LLM is provided" in {
    val detector = new ConflictDetectorImpl(llmJudge = None)
    val sc1 = makeScoredClaim("handles billing", entityId)
    val sc2 = makeScoredClaim("does not handle billing", entityId)
    val conflicts = detector.detect(Vector(sc1, sc2))
    conflicts should not be empty

    detector.refineWithLlm(conflicts, Vector(sc1, sc2)).asserting { refined =>
      refined shouldBe conflicts
    }
  }

  // Test 3: ConflictDetectorImpl with LLM that confirms conflict
  it should "upgrade conflict reason with LLM explanation" in {
    val mockJudge = new LlmJudge {
      def judge(a: Claim, b: Claim): IO[Option[LlmJudgment]] =
        IO.pure(Some(LlmJudgment(
          isConflict = true,
          confidence = 0.95,
          explanation = "These claims directly contradict each other",
          preferredClaim = Some(a.id)
        )))
    }
    val detector = new ConflictDetectorImpl(llmJudge = Some(mockJudge))
    val sc1 = makeScoredClaim("handles billing", entityId)
    val sc2 = makeScoredClaim("does not handle billing", entityId)
    val conflicts = detector.detect(Vector(sc1, sc2))

    detector.refineWithLlm(conflicts, Vector(sc1, sc2)).asserting { refined =>
      refined should have length conflicts.length.toLong
      refined.head.reason should include("[LLM:")
      refined.head.recommendation should include("LLM recommends")
    }
  }

  // Test 4: ConflictDetectorImpl with LLM that dismisses conflict
  it should "dismiss conflicts when LLM says no conflict" in {
    val mockJudge = new LlmJudge {
      def judge(a: Claim, b: Claim): IO[Option[LlmJudgment]] =
        IO.pure(Some(LlmJudgment(
          isConflict = false,
          confidence = 0.9,
          explanation = "These are complementary, not contradictory",
          preferredClaim = None
        )))
    }
    val detector = new ConflictDetectorImpl(llmJudge = Some(mockJudge))
    val sc1 = makeScoredClaim("handles billing", entityId)
    val sc2 = makeScoredClaim("billing service handler", entityId)
    val conflicts = detector.detect(Vector(sc1, sc2))

    detector.refineWithLlm(conflicts, Vector(sc1, sc2)).asserting { refined =>
      refined shouldBe empty
    }
  }

  // Test 5: Empty conflicts — nothing to refine
  it should "return empty when no conflicts to refine" in {
    val detector = new ConflictDetectorImpl(llmJudge = Some(new StubLlmJudge()))
    detector.refineWithLlm(Vector.empty, Vector.empty).asserting { refined =>
      refined shouldBe empty
    }
  }
}
