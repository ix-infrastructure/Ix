package ix.memory.model

import java.time.Instant

import io.circe.{Decoder, Encoder, Json}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

sealed trait NodeKind
object NodeKind {
  case object Module      extends NodeKind
  case object File        extends NodeKind
  case object Class       extends NodeKind
  case object Function    extends NodeKind
  case object Variable    extends NodeKind
  case object Config      extends NodeKind
  case object ConfigEntry extends NodeKind
  case object Service     extends NodeKind
  case object Endpoint    extends NodeKind

  private val nameMap: Map[String, NodeKind] = Map(
    "Module"      -> Module,
    "File"        -> File,
    "Class"       -> Class,
    "Function"    -> Function,
    "Variable"    -> Variable,
    "Config"      -> Config,
    "ConfigEntry" -> ConfigEntry,
    "Service"     -> Service,
    "Endpoint"    -> Endpoint
  )

  implicit val encoder: Encoder[NodeKind] = Encoder[String].contramap {
    case Module      => "Module"
    case File        => "File"
    case Class       => "Class"
    case Function    => "Function"
    case Variable    => "Variable"
    case Config      => "Config"
    case ConfigEntry => "ConfigEntry"
    case Service     => "Service"
    case Endpoint    => "Endpoint"
  }

  implicit val decoder: Decoder[NodeKind] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown NodeKind: $s")
  }
}

final case class GraphNode(
  id:         NodeId,
  kind:       NodeKind,
  tenant:     TenantId,
  attrs:      Json,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev],
  createdAt:  Instant,
  updatedAt:  Instant
)

object GraphNode {
  import Provenance.{instantEncoder, instantDecoder}

  implicit val encoder: Encoder[GraphNode] = deriveEncoder[GraphNode]
  implicit val decoder: Decoder[GraphNode] = deriveDecoder[GraphNode]
}
