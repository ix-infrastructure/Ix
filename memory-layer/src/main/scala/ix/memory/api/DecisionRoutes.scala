package ix.memory.api

import cats.effect.IO
import io.circe.Decoder
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi

case class DecisionListRequest(limit: Option[Int] = None, topic: Option[String] = None)

object DecisionListRequest {
  implicit val decoder: Decoder[DecisionListRequest] = deriveDecoder[DecisionListRequest]
}

class DecisionRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "decisions" =>
      (for {
        body  <- req.as[DecisionListRequest]
        nodes <- queryApi.listDecisions(body.limit.getOrElse(50), body.topic)
        resp  <- Ok(nodes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
