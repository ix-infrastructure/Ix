package ix.memory.context

import java.time.Instant
import java.util.UUID
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.Json
import ix.memory.model._

class ConfidenceScorerSpec extends AnyFlatSpec with Matchers {
  val scorer = new ConfidenceScorerImpl()

  private def makeClaim(sourceType: SourceType, rev: Long = 1L): Claim = Claim(
    id = ClaimId(UUID.randomUUID()),
    entityId = NodeId(UUID.randomUUID()),
    statement = "test statement",
    value = Json.Null,
    confidence = None,
    status = ClaimStatus.Active,
    provenance = Provenance("test.py", Some("abc123"), "tree-sitter", sourceType, Instant.now()),
    createdRev = Rev(rev),
    deletedRev = None
  )

  private val defaultCtx = ScoringContext(
    latestRev = Rev(5L),
    sourceChanged = false,
    corroboratingCount = 1,
    conflictState = ConflictState.NoConflict,
    intentAlignment = IntentAlignment.NoConnection,
    observedAt = Instant.now()
  )

  "ConfidenceScorer" should "score code-sourced claims higher than doc-sourced" in {
    val codeClaim = makeClaim(SourceType.Code)
    val docClaim = makeClaim(SourceType.Doc)

    val codeResult = scorer.score(codeClaim, defaultCtx)
    val docResult = scorer.score(docClaim, defaultCtx)

    codeResult.confidence.score should be > docResult.confidence.score
  }

  it should "penalize claims with conflicts" in {
    val claim = makeClaim(SourceType.Code)
    val noConflict = scorer.score(claim, defaultCtx.copy(conflictState = ConflictState.NoConflict))
    val withConflict = scorer.score(claim, defaultCtx.copy(conflictState = ConflictState.ExistsHigherAuthority))

    noConflict.confidence.score should be > withConflict.confidence.score
  }

  it should "boost claims with corroboration" in {
    val claim = makeClaim(SourceType.Code)
    val single = scorer.score(claim, defaultCtx.copy(corroboratingCount = 1))
    val corroborated = scorer.score(claim, defaultCtx.copy(corroboratingCount = 3))

    corroborated.confidence.score should be > single.confidence.score
  }

  it should "provide explainable breakdown" in {
    val claim = makeClaim(SourceType.Code)
    val result = scorer.score(claim, defaultCtx)

    result.confidence.baseAuthority.reason should include("Code")
    result.confidence.score should be > 0.0
    result.confidence.score should be <= 1.0
  }

  it should "reduce score for stale sources" in {
    val claim = makeClaim(SourceType.Code)
    val fresh = scorer.score(claim, defaultCtx.copy(sourceChanged = false))
    // Use an observedAt 60 days in the past so the recency penalty kicks in
    val staleObservedAt = Instant.now().minus(java.time.Duration.ofDays(60))
    val stale = scorer.score(claim, defaultCtx.copy(sourceChanged = true, observedAt = staleObservedAt))

    fresh.confidence.score should be > stale.confidence.score
  }

  it should "severely penalize conflict resolved against" in {
    val claim = makeClaim(SourceType.Code)
    val result = scorer.score(claim, defaultCtx.copy(conflictState = ConflictState.ResolvedAgainst))

    result.confidence.score should be < 0.5
  }
}
