package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.{Direction, ExpandResult, GraphQueryApi}
import ix.memory.model._

case class ExpandRequest(
  nodeId: String,
  direction: Option[String] = None,
  predicates: Option[List[String]] = None,
  hops: Option[Int] = None,
  asOfRev: Option[Long] = None
)

object ExpandRequest {
  implicit val decoder: Decoder[ExpandRequest] = deriveDecoder[ExpandRequest]
}

case class ExpandByNameRequest(
  name: String,
  direction: Option[String] = None,
  predicates: Option[List[String]] = None,
  kinds: Option[List[String]] = None
)

object ExpandByNameRequest {
  implicit val decoder: Decoder[ExpandByNameRequest] = deriveDecoder[ExpandByNameRequest]
}

class ExpandRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "expand" =>
      (for {
        body <- req.as[ExpandRequest]
        nodeId <- IO.fromOption(
          scala.util.Try(UUID.fromString(body.nodeId)).toOption.map(NodeId(_))
        )(new IllegalArgumentException(s"Invalid node ID: ${body.nodeId}"))
        dir = body.direction match {
          case Some("in")  => Direction.In
          case Some("out") => Direction.Out
          case _           => Direction.Both
        }
        preds = body.predicates.map(_.toSet)
        result <- queryApi.expand(nodeId, dir, preds, body.hops.getOrElse(1), body.asOfRev.map(Rev(_)))
        resp <- Ok(result.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case req @ POST -> Root / "v1" / "expand-by-name" =>
      (for {
        body <- req.as[ExpandByNameRequest]
        dir = body.direction match {
          case Some("in")  => Direction.In
          case Some("out") => Direction.Out
          case _           => Direction.Both
        }
        preds = body.predicates.map(_.toSet)
        kinds = body.kinds.map(_.flatMap(k =>
          NodeKind.decoder.decodeJson(io.circe.Json.fromString(k)).toOption
        ).toSet)
        result <- queryApi.expandByName(body.name, dir, preds, kinds)
        resp <- Ok(result.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
