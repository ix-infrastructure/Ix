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

case class SearchRequest(term: String, limit: Option[Int] = None)

object SearchRequest {
  implicit val decoder: Decoder[SearchRequest] = deriveDecoder[SearchRequest]
}

class SearchRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "search" =>
      (for {
        body    <- req.as[SearchRequest]
        nodes   <- queryApi.searchNodes(body.term, body.limit.getOrElse(20))
        resp    <- Ok(nodes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
