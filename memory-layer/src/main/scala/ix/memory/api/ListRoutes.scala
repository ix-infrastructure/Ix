package ix.memory.api

import cats.effect.IO
import io.circe.Decoder
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi
import ix.memory.model._

case class ListRequest(
  kind: String,
  limit: Option[Int] = None
)

object ListRequest {
  implicit val decoder: Decoder[ListRequest] = deriveDecoder[ListRequest]
}

class ListRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "list" =>
      (for {
        body  <- req.as[ListRequest]
        kind  <- IO.fromEither(
                   NodeKind.decoder.decodeJson(io.circe.Json.fromString(body.kind))
                     .left.map(e => new IllegalArgumentException(s"Unknown kind: ${body.kind}"))
                 )
        nodes <- queryApi.findNodesByKind(kind, body.limit.getOrElse(200))
        resp  <- Ok(nodes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
