package ix.memory.context

import java.util.UUID

import cats.effect.IO
import cats.implicits._
import org.slf4j.LoggerFactory
import ix.memory.model._

trait ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport]
}

class ConflictDetectorImpl(llmJudge: Option[LlmJudge] = None) extends ConflictDetector {

  private val log = LoggerFactory.getLogger(classOf[ConflictDetectorImpl])

  /**
   * Conflict detection with relevance filtering.
   *
   * Only flags conflicts between claims that share a field prefix
   * (e.g. both start with "calls:") or have keyword-stem overlap.
   * Caps at 20 active claims per entity and 10 conflicts per entity
   * to prevent combinatorial explosion.
   */
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] = {
    val byEntity = claims.groupBy(_.claim.entityId)

    byEntity.values.flatMap { entityClaims =>
      val activeClaims = entityClaims.filter(_.claim.status == ClaimStatus.Active).take(20)

      if (activeClaims.size < 2) Vector.empty
      else {
        // PASS 1: Hard conflicts (same statement/field, different values)
        val hardConflicts: Vector[ConflictReport] = {
          val byStatement = activeClaims.groupBy(_.claim.statement)

          byStatement.values.toVector.flatMap { sameFieldClaims =>
            // Group by value (stringified) to find distinct values for this field
            val byValue = sameFieldClaims.groupBy(sc => sc.claim.value.noSpaces)
            if (byValue.size <= 1) Vector.empty
            else {
              // Pick one representative claim per distinct value (highest confidence wins)
              val reps = byValue.values.toVector.map { claimsForValue =>
                claimsForValue.maxBy(_.confidence.score)
              }
              val winner = reps.maxBy(_.confidence.score)

              // Emit one conflict per losing value against the winner
              reps.filterNot(_.claim.id == winner.claim.id).map { loser =>
                makeConflict(winner, loser, "Conflicting values for same field")
              }
            }
          }
        }

        // PASS 2: Soft conflicts (heuristics) only if we found no hard conflicts.
        // These are useful for surfacing potential inconsistencies, but can be noisy.
        val softConflicts: Vector[ConflictReport] =
          if (hardConflicts.nonEmpty) Vector.empty
          else {
            val candidates = activeClaims.filter(sc => sc.relevance >= 0.25)
            val pairs = candidates.combinations(2).toVector
            pairs.flatMap {
              case Vector(a, b) if a.claim.statement == b.claim.statement =>
                None // Same statement — not a conflict
              case Vector(a, b) =>
                if (shareFieldPrefix(a.claim.statement, b.claim.statement)) {
                  Some(makeConflict(a, b, "Potential inconsistency (same field prefix)"))
                }
                else if (keywordsOverlap(a.claim.statement, b.claim.statement)) {
                  Some(makeConflict(a, b, "Potential inconsistency (keyword overlap)"))
                }
                else None
              case _ => None
            }
          }

        val conflicts = (hardConflicts ++ softConflicts).take(10)

        if (conflicts.nonEmpty) {
          log.warn("Detected {} conflict(s) for entity {}", conflicts.size, entityClaims.head.claim.entityId.value)
        }
        conflicts
      }
    }.toVector
  }

  /**
   * Pass 3: LLM-assisted conflict detection.
   *
   * Takes the conflicts found by Pass 1+2 and asks the LLM to evaluate
   * whether each pair truly conflicts semantically. This can:
   * - Upgrade the reason with LLM explanation
   * - Dismiss false positives (remove conflict)
   * - Provide a preferred claim recommendation
   *
   * Only runs if an LlmJudge is provided.
   */
  def refineWithLlm(
    conflicts: Vector[ConflictReport],
    claims: Vector[ScoredClaim]
  ): IO[Vector[ConflictReport]] = {
    llmJudge match {
      case None => IO.pure(conflicts) // No LLM, return as-is
      case Some(judge) =>
        conflicts.traverse { conflict =>
          val claimA = claims.find(_.claim.id == conflict.claimA).map(_.claim)
          val claimB = claims.find(_.claim.id == conflict.claimB).map(_.claim)

          (claimA, claimB) match {
            case (Some(a), Some(b)) =>
              judge.judge(a, b).map {
                case Some(judgment) if judgment.isConflict =>
                  Some(conflict.copy(
                    reason = s"${conflict.reason} [LLM: ${judgment.explanation}]",
                    recommendation = judgment.preferredClaim
                      .flatMap(id => claims.find(_.claim.id == id))
                      .map(sc => s"LLM recommends '${sc.claim.statement}' (LLM confidence: ${judgment.confidence})")
                      .getOrElse(conflict.recommendation)
                  ))
                case Some(_) =>
                  // LLM says not a conflict — dismiss
                  None
                case None =>
                  // LLM didn't respond — keep original
                  Some(conflict)
              }
            case _ =>
              // Claims not found — keep original conflict
              IO.pure(Some(conflict))
          }
        }.map(_.flatten)
    }
  }

  /** Check whether two statements share a field prefix (e.g. both start with "calls:"). */
  private def shareFieldPrefix(a: String, b: String): Boolean = {
    val idxA = a.indexOf(':')
    val idxB = b.indexOf(':')
    idxA > 0 && idxB > 0 && a.substring(0, idxA) == b.substring(0, idxB)
  }

  /** Check whether two statement strings share at least one 4-char stem. */
  private def keywordsOverlap(a: String, b: String): Boolean = {
    val stemsA = tokenize(a).map(_.take(4).toLowerCase).toSet
    val stemsB = tokenize(b).map(_.take(4).toLowerCase).toSet
    (stemsA intersect stemsB).nonEmpty
  }

  /** Split on non-alphanumeric runs, keep tokens of length >= 3. */
  private def tokenize(s: String): Vector[String] =
    s.split("[^a-zA-Z0-9]+").filter(_.length >= 3).toVector

  private def makeConflict(a: ScoredClaim, b: ScoredClaim, reason: String): ConflictReport = {
    val (winner, _) =
      if (a.confidence.score >= b.confidence.score) (a, b) else (b, a)
    ConflictReport(
      id             = ConflictId(UUID.randomUUID()),
      claimA         = a.claim.id,
      claimB         = b.claim.id,
      reason         = reason,
      recommendation = s"Prefer '${winner.claim.statement}' (confidence: ${winner.confidence.score})"
    )
  }
}

/** Stub kept for backward compatibility -- prefer ConflictDetectorImpl. */
class DefaultConflictDetector extends ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] =
    Vector.empty
}
