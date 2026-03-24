package ix.memory.model

import java.time.Instant

import io.circe.{Decoder, DecodingFailure, Encoder, HCursor, Json}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.syntax._

sealed trait PatchOp
object PatchOp {
  final case class UpsertNode(id: NodeId, kind: NodeKind, name: String, attrs: Map[String, Json]) extends PatchOp
  final case class UpsertEdge(id: EdgeId, src: NodeId, dst: NodeId, predicate: EdgePredicate, attrs: Map[String, Json]) extends PatchOp
  final case class DeleteNode(id: NodeId)   extends PatchOp
  final case class DeleteEdge(id: EdgeId)   extends PatchOp
  final case class AssertClaim(
    entityId:         NodeId,
    field:            String,
    value:            Json,
    confidence:       Option[Double],
    /** Inference pass identifier. Absent for observed facts; required for inferred claims. */
    inferenceVersion: Option[String] = None
  ) extends PatchOp
  final case class RetractClaim(claimId: ClaimId) extends PatchOp

  implicit val encoder: Encoder[PatchOp] = Encoder.instance {
    case UpsertNode(id, kind, name, attrs) =>
      Json.obj("type" -> "UpsertNode".asJson, "id" -> id.asJson, "kind" -> kind.asJson, "name" -> name.asJson, "attrs" -> attrs.asJson)
    case UpsertEdge(id, src, dst, predicate, attrs) =>
      Json.obj("type" -> "UpsertEdge".asJson, "id" -> id.asJson, "src" -> src.asJson, "dst" -> dst.asJson, "predicate" -> predicate.asJson, "attrs" -> attrs.asJson)
    case DeleteNode(id)        => Json.obj("type" -> "DeleteNode".asJson, "id" -> id.asJson)
    case DeleteEdge(id)        => Json.obj("type" -> "DeleteEdge".asJson, "id" -> id.asJson)
    case AssertClaim(entityId, field, value, confidence, inferenceVersion) =>
      Json.obj("type" -> "AssertClaim".asJson, "entityId" -> entityId.asJson, "field" -> field.asJson, "value" -> value.asJson, "confidence" -> confidence.asJson, "inferenceVersion" -> inferenceVersion.asJson)
    case RetractClaim(claimId) => Json.obj("type" -> "RetractClaim".asJson, "claimId" -> claimId.asJson)
  }

  implicit val decoder: Decoder[PatchOp] = Decoder.instance { (c: HCursor) =>
    c.downField("type").as[String].flatMap {
      case "UpsertNode" =>
        for {
          id   <- c.downField("id").as[NodeId]
          kind <- c.downField("kind").as[NodeKind]
          name <- c.downField("name").as[String]
          attrs <- c.downField("attrs").as[Map[String, Json]]
        } yield UpsertNode(id, kind, name, attrs)
      case "UpsertEdge" =>
        for {
          id        <- c.downField("id").as[EdgeId]
          src       <- c.downField("src").as[NodeId]
          dst       <- c.downField("dst").as[NodeId]
          predicate <- c.downField("predicate").as[EdgePredicate]
          attrs     <- c.downField("attrs").as[Map[String, Json]]
        } yield UpsertEdge(id, src, dst, predicate, attrs)
      case "DeleteNode"   => c.downField("id").as[NodeId].map(DeleteNode)
      case "DeleteEdge"   => c.downField("id").as[EdgeId].map(DeleteEdge)
      case "AssertClaim" =>
        for {
          entityId         <- c.downField("entityId").as[NodeId]
          field            <- c.downField("field").as[String]
          value            <- c.downField("value").as[Json]
          confidence       <- c.downField("confidence").as[Option[Double]]
          inferenceVersion <- c.downField("inferenceVersion").as[Option[String]]
        } yield AssertClaim(entityId, field, value, confidence, inferenceVersion)
      case "RetractClaim" => c.downField("claimId").as[ClaimId].map(RetractClaim)
      case other          => Left(DecodingFailure(s"Unknown PatchOp type: $other", c.history))
    }
  }
}

final case class PatchSource(
  uri:        String,
  sourceHash: Option[String],
  extractor:  String,
  sourceType: SourceType
)

object PatchSource {
  implicit val encoder: Encoder[PatchSource] = deriveEncoder[PatchSource]
  implicit val decoder: Decoder[PatchSource] = deriveDecoder[PatchSource]
}

final case class GraphPatch(
  patchId:   PatchId,
  actor:     String,
  timestamp: Instant,
  source:    PatchSource,
  baseRev:   Rev,
  ops:       Vector[PatchOp],
  replaces:  Vector[PatchId],
  intent:    Option[String]
)

object GraphPatch {
  import Provenance.{instantEncoder, instantDecoder}

  implicit val encoder: Encoder[GraphPatch] = deriveEncoder[GraphPatch]
  implicit val decoder: Decoder[GraphPatch] = deriveDecoder[GraphPatch]
}
