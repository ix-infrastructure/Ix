package ix.memory.model

import java.util.UUID

import io.circe.{Decoder, Encoder}

final case class NodeId(value: UUID) extends AnyVal
object NodeId {
  implicit val encoder: Encoder[NodeId] = Encoder[UUID].contramap(_.value)
  implicit val decoder: Decoder[NodeId] = Decoder[UUID].map(NodeId(_))
}

final case class EdgeId(value: UUID) extends AnyVal
object EdgeId {
  implicit val encoder: Encoder[EdgeId] = Encoder[UUID].contramap(_.value)
  implicit val decoder: Decoder[EdgeId] = Decoder[UUID].map(EdgeId(_))
}

final case class PatchId(value: UUID) extends AnyVal
object PatchId {
  implicit val encoder: Encoder[PatchId] = Encoder[UUID].contramap(_.value)
  implicit val decoder: Decoder[PatchId] = Decoder[UUID].map(PatchId(_))
}

final case class ClaimId(value: UUID) extends AnyVal
object ClaimId {
  implicit val encoder: Encoder[ClaimId] = Encoder[UUID].contramap(_.value)
  implicit val decoder: Decoder[ClaimId] = Decoder[UUID].map(ClaimId(_))
}

final case class ConflictId(value: UUID) extends AnyVal
object ConflictId {
  implicit val encoder: Encoder[ConflictId] = Encoder[UUID].contramap(_.value)
  implicit val decoder: Decoder[ConflictId] = Decoder[UUID].map(ConflictId(_))
}

final case class Rev(value: Long) extends AnyVal
object Rev {
  implicit val encoder: Encoder[Rev] = Encoder[Long].contramap(_.value)
  implicit val decoder: Decoder[Rev] = Decoder[Long].map(Rev(_))
}
