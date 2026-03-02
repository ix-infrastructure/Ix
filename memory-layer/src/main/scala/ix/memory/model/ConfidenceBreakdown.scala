package ix.memory.model

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

final case class Factor(value: Double, reason: String)

object Factor {
  implicit val encoder: Encoder[Factor] = deriveEncoder[Factor]
  implicit val decoder: Decoder[Factor] = deriveDecoder[Factor]
}

final case class ConfidenceBreakdown(
  baseAuthority:   Factor,
  verification:    Factor,
  recency:         Factor,
  corroboration:   Factor,
  conflictPenalty: Factor
) {

  /** Confidence score = product of all factor values, clamped to [0, 1]. */
  def score: Double = {
    val raw = baseAuthority.value *
      verification.value *
      recency.value *
      corroboration.value *
      conflictPenalty.value
    math.max(0.0, math.min(1.0, raw))
  }
}

object ConfidenceBreakdown {
  implicit val encoder: Encoder[ConfidenceBreakdown] = deriveEncoder[ConfidenceBreakdown]
  implicit val decoder: Decoder[ConfidenceBreakdown] = deriveDecoder[ConfidenceBreakdown]
}
