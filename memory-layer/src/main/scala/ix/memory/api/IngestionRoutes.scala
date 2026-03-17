package ix.memory.api

import java.nio.file.Paths

import cats.effect.IO
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.ingestion.{BulkIngestionService, IngestionProgress, IngestionService}
import org.typelevel.log4cats.slf4j.Slf4jLogger

case class IngestRequest(path: String, language: Option[String], recursive: Option[Boolean], force: Option[Boolean])

object IngestRequest {
  implicit val decoder: Decoder[IngestRequest] = deriveDecoder[IngestRequest]
  implicit val encoder: Encoder[IngestRequest] = deriveEncoder[IngestRequest]
}

case class SkipReasonsResponse(unchanged: Int, emptyFile: Int, parseError: Int, tooLarge: Int)

object SkipReasonsResponse {
  implicit val encoder: Encoder[SkipReasonsResponse] = deriveEncoder[SkipReasonsResponse]
  implicit val decoder: Decoder[SkipReasonsResponse] = deriveDecoder[SkipReasonsResponse]
}

case class IngestResponse(filesProcessed: Int, patchesApplied: Int, filesSkipped: Int,
  entitiesCreated: Int, latestRev: Long, skipReasons: SkipReasonsResponse)

object IngestResponse {
  implicit val encoder: Encoder[IngestResponse] = deriveEncoder[IngestResponse]
  implicit val decoder: Decoder[IngestResponse] = deriveDecoder[IngestResponse]
}

class IngestionRoutes(ingestionService: IngestionService, bulkIngestionService: BulkIngestionService) {

  private val logger = Slf4jLogger.getLoggerFromName[IO]("ix.ingest.progress")

  private val progressLog: IngestionProgress => IO[Unit] = { p =>
    logger.info(s"discovered=${p.filesDiscovered} parsed=${p.filesParsed} chunks=${p.chunksWritten}/${p.totalChunks}")
  }

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "ingest" =>
      (for {
        body     <- req.as[IngestRequest]
        _        <- IO.raiseWhen(body.path.contains(".."))(
          new IllegalArgumentException("Path traversal not allowed")
        )
        path      = Paths.get(body.path)
        result   <- bulkIngestionService.ingestPath(path, body.language, body.recursive.getOrElse(false), progressLog, body.force.getOrElse(false))
        resp     <- Ok(IngestResponse(
          filesProcessed  = result.filesProcessed,
          patchesApplied  = result.patchesApplied,
          filesSkipped    = result.filesSkipped,
          entitiesCreated = result.entitiesCreated,
          latestRev       = result.latestRev.value,
          skipReasons     = SkipReasonsResponse(
            result.skipReasons.unchanged,
            result.skipReasons.emptyFile,
            result.skipReasons.parseError,
            result.skipReasons.tooLarge
          )
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
