package ix.memory.model

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

sealed trait ConflictStatus
object ConflictStatus {
  case object Open      extends ConflictStatus
  case object Resolved  extends ConflictStatus
  case object Dismissed extends ConflictStatus

  private val nameMap: Map[String, ConflictStatus] = Map(
    "Open"      -> Open,
    "Resolved"  -> Resolved,
    "Dismissed" -> Dismissed
  )

  implicit val encoder: Encoder[ConflictStatus] = Encoder[String].contramap {
    case Open      => "Open"
    case Resolved  => "Resolved"
    case Dismissed => "Dismissed"
  }

  implicit val decoder: Decoder[ConflictStatus] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown ConflictStatus: $s")
  }
}

final case class ConflictSet(
  id:              ConflictId,
  reason:          String,
  status:          ConflictStatus,
  candidateClaims: List[ClaimId],
  winnerClaimId:   Option[ClaimId],
  createdRev:      Rev
)

object ConflictSet {
  implicit val encoder: Encoder[ConflictSet] = deriveEncoder[ConflictSet]
  implicit val decoder: Decoder[ConflictSet] = deriveDecoder[ConflictSet]
}
