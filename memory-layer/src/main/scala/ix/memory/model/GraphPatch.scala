package ix.memory.model

import java.time.Instant

import io.circe.{Decoder, DecodingFailure, Encoder, HCursor, Json}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.syntax._

sealed trait PatchOp
object PatchOp {
  final case class UpsertNode(node: GraphNode)  extends PatchOp
  final case class UpsertEdge(edge: GraphEdge)  extends PatchOp
  final case class DeleteNode(nodeId: NodeId)   extends PatchOp
  final case class DeleteEdge(edgeId: EdgeId)   extends PatchOp
  final case class AssertClaim(claim: Claim)     extends PatchOp
  final case class RetractClaim(claimId: ClaimId) extends PatchOp

  implicit val encoder: Encoder[PatchOp] = Encoder.instance {
    case UpsertNode(node)     => Json.obj("type" -> "UpsertNode".asJson, "node" -> node.asJson)
    case UpsertEdge(edge)     => Json.obj("type" -> "UpsertEdge".asJson, "edge" -> edge.asJson)
    case DeleteNode(nodeId)   => Json.obj("type" -> "DeleteNode".asJson, "nodeId" -> nodeId.asJson)
    case DeleteEdge(edgeId)   => Json.obj("type" -> "DeleteEdge".asJson, "edgeId" -> edgeId.asJson)
    case AssertClaim(claim)   => Json.obj("type" -> "AssertClaim".asJson, "claim" -> claim.asJson)
    case RetractClaim(claimId) => Json.obj("type" -> "RetractClaim".asJson, "claimId" -> claimId.asJson)
  }

  implicit val decoder: Decoder[PatchOp] = Decoder.instance { (c: HCursor) =>
    c.downField("type").as[String].flatMap {
      case "UpsertNode"   => c.downField("node").as[GraphNode].map(UpsertNode)
      case "UpsertEdge"   => c.downField("edge").as[GraphEdge].map(UpsertEdge)
      case "DeleteNode"   => c.downField("nodeId").as[NodeId].map(DeleteNode)
      case "DeleteEdge"   => c.downField("edgeId").as[EdgeId].map(DeleteEdge)
      case "AssertClaim"  => c.downField("claim").as[Claim].map(AssertClaim)
      case "RetractClaim" => c.downField("claimId").as[ClaimId].map(RetractClaim)
      case other          => Left(DecodingFailure(s"Unknown PatchOp type: $other", c.history))
    }
  }
}

final case class PatchSource(
  uri: String,
  ref: Option[String]
)

object PatchSource {
  implicit val encoder: Encoder[PatchSource] = deriveEncoder[PatchSource]
  implicit val decoder: Decoder[PatchSource] = deriveDecoder[PatchSource]
}

final case class GraphPatch(
  patchId:   PatchId,
  tenant:    TenantId,
  actor:     String,
  timestamp: Instant,
  source:    PatchSource,
  baseRev:   Rev,
  ops:       List[PatchOp],
  replaces:  Option[PatchId],
  intent:    Option[String]
)

object GraphPatch {
  import Provenance.{instantEncoder, instantDecoder}

  implicit val encoder: Encoder[GraphPatch] = deriveEncoder[GraphPatch]
  implicit val decoder: Decoder[GraphPatch] = deriveDecoder[GraphPatch]
}
