package ix.memory.context

import java.time.Instant

import ix.memory.model._

trait ConfidenceScorer {
  def score(claim: Claim, ctx: ScoringContext): ScoredClaim
}

case class ScoringContext(
  latestRev:          Rev,
  sourceChanged:      Boolean,
  corroboratingCount: Int,
  conflictState:      ConflictState,
  intentAlignment:    IntentAlignment,
  observedAt:         Instant
)

sealed trait ConflictState
object ConflictState {
  case object NoConflict            extends ConflictState
  case object ExistsHigherAuthority extends ConflictState
  case object ExistsLowerAuthority  extends ConflictState
  case object ResolvedFor           extends ConflictState
  case object ResolvedAgainst       extends ConflictState
}

sealed trait IntentAlignment
object IntentAlignment {
  case object DirectlyLinked    extends IntentAlignment   // x 1.1
  case object WithinTwoHops     extends IntentAlignment   // x 1.05
  case object NoConnection      extends IntentAlignment   // x 1.0
  case object ContradictsIntent extends IntentAlignment   // x 0.85
}

class ConfidenceScorerImpl extends ConfidenceScorer {
  def score(claim: Claim, ctx: ScoringContext): ScoredClaim = {
    val base = Factor(
      SourceType.baseAuthority(claim.provenance.sourceType),
      s"${claim.provenance.sourceType}, ${claim.provenance.extractor}"
    )

    val verif = Factor(1.0, "no verification data available")

    val recency = computeRecency(ctx)
    val corr = computeCorroboration(ctx.corroboratingCount)
    val conflict = computeConflictPenalty(ctx.conflictState)
    val intent = computeIntentAlignment(ctx.intentAlignment)

    ScoredClaim(claim, ConfidenceBreakdown(base, verif, recency, corr, conflict, intent))
  }

  private def computeRecency(ctx: ScoringContext): Factor = {
    if (!ctx.sourceChanged) return Factor(1.0, "Source unchanged since observation")
    val age = java.time.Duration.between(ctx.observedAt, Instant.now())
    val days = age.toDays
    val (value, reason) = days match {
      case d if d < 1    => (1.0,  "< 1 day ago")
      case d if d <= 7   => (0.95, "1-7 days ago")
      case d if d <= 28  => (0.85, "1-4 weeks ago")
      case d if d <= 180 => (0.70, "1-6 months ago")
      case _             => (0.50, "6+ months ago")
    }
    Factor(value, reason)
  }

  private def computeCorroboration(count: Int): Factor = {
    val value = count match {
      case 0 => 1.0   // No data (neutral)
      case 1 => 1.0   // Single source (neutral)
      case 2 => 1.05  // Two sources agree
      case n if n >= 3 => 1.1  // Strong corroboration
    }
    Factor(value, s"$count corroborating sources")
  }

  private def computeConflictPenalty(state: ConflictState): Factor = state match {
    case ConflictState.NoConflict            => Factor(1.0, "no conflicts")
    case ConflictState.ExistsLowerAuthority  => Factor(0.95, "conflict with lower authority source")
    case ConflictState.ExistsHigherAuthority => Factor(0.70, "conflict with higher authority source")
    case ConflictState.ResolvedFor           => Factor(1.05, "conflict resolved in favor")
    case ConflictState.ResolvedAgainst       => Factor(0.30, "conflict resolved against")
  }

  private def computeIntentAlignment(alignment: IntentAlignment): Factor = alignment match {
    case IntentAlignment.DirectlyLinked    => Factor(1.1,  "Directly linked to active intent")
    case IntentAlignment.WithinTwoHops     => Factor(1.05, "Connected to intent within 2 hops")
    case IntentAlignment.NoConnection      => Factor(1.0,  "No connection to intent")
    case IntentAlignment.ContradictsIntent => Factor(0.85, "Contradicts active intent")
  }
}
