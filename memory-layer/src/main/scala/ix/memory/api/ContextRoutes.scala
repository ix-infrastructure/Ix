package ix.memory.api

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.context.ContextService
import ix.memory.model.Rev

case class ContextRequest(query: String, asOfRev: Option[Long])

object ContextRequest {
  implicit val decoder: Decoder[ContextRequest] = deriveDecoder[ContextRequest]
  implicit val encoder: Encoder[ContextRequest] = deriveEncoder[ContextRequest]
}

class ContextRoutes(contextService: ContextService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "context" =>
      (for {
        body     <- req.as[ContextRequest]
        asOfRev   = body.asOfRev.map(Rev(_))
        result   <- contextService.query(body.query, asOfRev)
        resp     <- Ok(result)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
