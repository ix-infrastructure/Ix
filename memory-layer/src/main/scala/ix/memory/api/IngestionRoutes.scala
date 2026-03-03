package ix.memory.api

import java.nio.file.Paths

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.ingestion.IngestionService

case class IngestRequest(path: String, language: Option[String], recursive: Option[Boolean])

object IngestRequest {
  implicit val decoder: Decoder[IngestRequest] = deriveDecoder[IngestRequest]
  implicit val encoder: Encoder[IngestRequest] = deriveEncoder[IngestRequest]
}

case class IngestResponse(filesProcessed: Int, patchesApplied: Int, entitiesCreated: Int, latestRev: Long)

object IngestResponse {
  implicit val encoder: Encoder[IngestResponse] = deriveEncoder[IngestResponse]
  implicit val decoder: Decoder[IngestResponse] = deriveDecoder[IngestResponse]
}

class IngestionRoutes(ingestionService: IngestionService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "ingest" =>
      (for {
        body     <- req.as[IngestRequest]
        _        <- IO.raiseWhen(body.path.contains(".."))(
          new IllegalArgumentException("Path traversal not allowed")
        )
        path      = Paths.get(body.path)
        result   <- ingestionService.ingestPath(path, body.language, body.recursive.getOrElse(false))
        resp     <- Ok(IngestResponse(
          filesProcessed  = result.filesProcessed,
          patchesApplied  = result.patchesApplied,
          entitiesCreated = result.entitiesCreated,
          latestRev       = result.latestRev.value
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
