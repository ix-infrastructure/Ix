package ix.memory.api

import cats.effect.IO
import cats.syntax.semigroupk._
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.conflict.ArcadeConflictService
import ix.memory.context.ContextService
import ix.memory.db.{ArcadeClient, GraphQueryApi, GraphWriteApi}
import ix.memory.ingestion.{BulkIngestionService, IngestionService}

object Routes {

  def arcade(
    contextService:       ContextService,
    ingestionService:     IngestionService,
    bulkIngestionService: BulkIngestionService,
    queryApi:             GraphQueryApi,
    writeApi:             GraphWriteApi,
    conflictService:      ArcadeConflictService,
    client:               ArcadeClient
  ): HttpRoutes[IO] = {

    val health = HttpRoutes.of[IO] {
      case GET -> Root / "v1" / "health" =>
        Ok(Json.obj("status" -> "ok".asJson))
    }

    val contextRoutes   = new ContextRoutes(contextService).routes
    val ingestionRoutes = new IngestionRoutes(ingestionService, bulkIngestionService).routes
    val entityRoutes    = new EntityRoutes(queryApi).routes
    val diffRoutes      = new DiffRoutes(queryApi).routes
    val conflictRoutes  = new ArcadeConflictRoutes(conflictService).routes
    val decideRoutes    = new DecideRoutes(writeApi).routes
    val searchRoutes    = new SearchRoutes(queryApi).routes
    val truthRoutes     = new TruthRoutes(writeApi, queryApi).routes
    val patchRoutes         = new ArcadePatchRoutes(client).routes
    val decisionListRoutes  = new DecisionRoutes(queryApi).routes
    val expandRoutes        = new ExpandRoutes(queryApi).routes
    val statsRoutes         = new ArcadeStatsRoutes(client).routes
    val patchCommitRoutes   = new PatchCommitRoutes(writeApi).routes
    val listRoutes          = new ListRoutes(queryApi).routes

    health <+> contextRoutes <+> ingestionRoutes <+> entityRoutes <+>
      diffRoutes <+> conflictRoutes <+> decideRoutes <+> searchRoutes <+>
      truthRoutes <+> patchRoutes <+> decisionListRoutes <+> expandRoutes <+>
      statsRoutes <+> patchCommitRoutes <+> listRoutes
  }
}
