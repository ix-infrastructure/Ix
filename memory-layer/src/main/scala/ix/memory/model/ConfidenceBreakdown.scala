package ix.memory.model

import io.circe.{Decoder, Encoder, Json}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.syntax._

final case class Factor(value: Double, reason: String)

object Factor {
  implicit val encoder: Encoder[Factor] = deriveEncoder[Factor]
  implicit val decoder: Decoder[Factor] = deriveDecoder[Factor]
}

final case class CompactConfidence(
  score:             Double,
  authority:         Option[Double],
  nonTrivialFactors: List[(String, Factor)]
)

object CompactConfidence {

  def isTrivial(f: Factor): Boolean = f.value >= 0.99 && f.value <= 1.01

  implicit val encoder: Encoder[CompactConfidence] = Encoder.instance { cc =>
    val base = List("score" -> Json.fromDoubleOrNull(cc.score))

    val auth = cc.authority.map(a => "authority" -> Json.fromDoubleOrNull(a)).toList

    val factors = if (cc.nonTrivialFactors.nonEmpty) {
      val obj = Json.obj(cc.nonTrivialFactors.map { case (name, factor) =>
        name -> factor.asJson
      }: _*)
      List("factors" -> obj)
    } else Nil

    Json.obj((base ++ auth ++ factors): _*)
  }

  implicit val decoder: Decoder[CompactConfidence] = Decoder.instance { c =>
    for {
      score     <- c.downField("score").as[Double]
      authority <- c.downField("authority").as[Option[Double]]
    } yield CompactConfidence(score, authority, Nil)
  }
}

final case class ConfidenceBreakdown(
  baseAuthority:   Factor,
  verification:    Factor,
  recency:         Factor,
  corroboration:   Factor,
  conflictPenalty: Factor,
  intentAlignment: Factor
) {

  /** Confidence score = product of all factor values, clamped to [0, 1]. */
  def score: Double = {
    val raw = baseAuthority.value *
      verification.value *
      recency.value *
      corroboration.value *
      conflictPenalty.value *
      intentAlignment.value
    math.max(0.0, math.min(1.0, raw))
  }

  /** Collapse trivial (≈1.0) multipliers into a compact representation. */
  def toCompact: CompactConfidence = {
    val candidates = List(
      "verification"    -> verification,
      "recency"         -> recency,
      "corroboration"   -> corroboration,
      "conflictPenalty" -> conflictPenalty,
      "intentAlignment" -> intentAlignment
    )
    val nonTrivial = candidates.filterNot { case (_, f) => CompactConfidence.isTrivial(f) }
    CompactConfidence(
      score             = score,
      authority         = Some(baseAuthority.value),
      nonTrivialFactors = nonTrivial
    )
  }
}

object ConfidenceBreakdown {
  implicit val encoder: Encoder[ConfidenceBreakdown] = deriveEncoder[ConfidenceBreakdown]
  implicit val decoder: Decoder[ConfidenceBreakdown] = deriveDecoder[ConfidenceBreakdown]
}
