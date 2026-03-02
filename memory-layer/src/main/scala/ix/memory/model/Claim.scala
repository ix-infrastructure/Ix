package ix.memory.model

import java.util.UUID

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

sealed trait ClaimStatus
object ClaimStatus {
  case object Active    extends ClaimStatus
  case object Stale     extends ClaimStatus
  case object Retracted extends ClaimStatus

  private val nameMap: Map[String, ClaimStatus] = Map(
    "Active"    -> Active,
    "Stale"     -> Stale,
    "Retracted" -> Retracted
  )

  implicit val encoder: Encoder[ClaimStatus] = Encoder[String].contramap {
    case Active    => "Active"
    case Stale     => "Stale"
    case Retracted => "Retracted"
  }

  implicit val decoder: Decoder[ClaimStatus] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown ClaimStatus: $s")
  }
}

final case class Claim(
  id:         ClaimId,
  entityId:   UUID,
  statement:  String,
  status:     ClaimStatus,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev]
)

object Claim {
  implicit val encoder: Encoder[Claim] = deriveEncoder[Claim]
  implicit val decoder: Decoder[Claim] = deriveDecoder[Claim]
}
