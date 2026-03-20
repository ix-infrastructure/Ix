package ix.memory.api

import cats.effect.IO
import io.circe.{Decoder, Json}
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi

class SourceHashRoutes(queryApi: GraphQueryApi) {

  private case class SourceHashRequest(uris: List[String])
  private implicit val reqDecoder: Decoder[SourceHashRequest] = deriveDecoder

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "source-hashes" =>
      (for {
        body   <- req.as[SourceHashRequest]
        hashes <- queryApi.getSourceHashes(body.uris)
        resp   <- Ok(Json.fromFields(hashes.map { case (k, v) => k -> v.asJson }))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case GET -> Root / "v1" / "source-hashes" / "exists" =>
      (for {
        exists <- queryApi.hasIngestBaseline()
        resp   <- Ok(Json.obj("exists" -> exists.asJson))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
