package ix.memory.model

import io.circe.{Decoder, Encoder, Json}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

final case class EdgePredicate(value: String) extends AnyVal
object EdgePredicate {
  implicit val encoder: Encoder[EdgePredicate] = Encoder[String].contramap(_.value)
  implicit val decoder: Decoder[EdgePredicate] = Decoder[String].map(EdgePredicate(_))
}

final case class GraphEdge(
  id:         EdgeId,
  src:        NodeId,
  dst:        NodeId,
  predicate:  EdgePredicate,
  attrs:      Json,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev]
)

object GraphEdge {
  implicit val encoder: Encoder[GraphEdge] = deriveEncoder[GraphEdge]
  implicit val decoder: Decoder[GraphEdge] = deriveDecoder[GraphEdge]
}
