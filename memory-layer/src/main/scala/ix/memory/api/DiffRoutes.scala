package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi
import ix.memory.model._

case class DiffRequest(fromRev: Long, toRev: Long, entityId: Option[String])

object DiffRequest {
  implicit val decoder: Decoder[DiffRequest] = deriveDecoder[DiffRequest]
  implicit val encoder: Encoder[DiffRequest] = deriveEncoder[DiffRequest]
}

case class DiffEntry(
  entityId:  NodeId,
  changeType: String,    // "added", "removed", "modified"
  atFromRev:  Option[GraphNode],
  atToRev:    Option[GraphNode]
)

object DiffEntry {
  implicit val encoder: Encoder[DiffEntry] = deriveEncoder[DiffEntry]
}

case class DiffResponse(fromRev: Long, toRev: Long, changes: Vector[DiffEntry])

object DiffResponse {
  implicit val encoder: Encoder[DiffResponse] = deriveEncoder[DiffResponse]
}

class DiffRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "diff" =>
      (for {
        body     <- req.as[DiffRequest]
        _        <- IO.raiseWhen(body.fromRev >= body.toRev)(
          new IllegalArgumentException("fromRev must be less than toRev")
        )
        changes  <- body.entityId match {
          case Some(eidStr) =>
            // Diff a single entity
            for {
              eid    <- IO.fromTry(scala.util.Try(UUID.fromString(eidStr))).map(NodeId(_))
              result <- diffEntity(eid, Rev(body.fromRev), Rev(body.toRev))
            } yield result.toVector
          case None =>
            queryApi.getChangedEntities(Rev(body.fromRev), Rev(body.toRev)).map { nodes =>
              nodes.map { n =>
                DiffEntry(
                  entityId   = n.id,
                  changeType = if (n.deletedRev.isDefined) "removed" else "added_or_modified",
                  atFromRev  = None,
                  atToRev    = Some(n)
                )
              }
            }
        }
        resp <- Ok(DiffResponse(body.fromRev, body.toRev, changes))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def diffEntity(
    nodeId: NodeId, fromRev: Rev, toRev: Rev
  ): IO[Option[DiffEntry]] =
    for {
      atFrom <- queryApi.getNode(nodeId, asOfRev = Some(fromRev))
      atTo   <- queryApi.getNode(nodeId, asOfRev = Some(toRev))
    } yield {
      (atFrom, atTo) match {
        case (None, None)       => None
        case (None, Some(_))    => Some(DiffEntry(nodeId, "added", None, atTo))
        case (Some(_), None)    => Some(DiffEntry(nodeId, "removed", atFrom, None))
        case (Some(a), Some(b)) =>
          if (a.updatedAt != b.updatedAt || a.attrs != b.attrs)
            Some(DiffEntry(nodeId, "modified", Some(a), Some(b)))
          else
            None
      }
    }

}
