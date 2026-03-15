package ix.memory.api

import cats.effect.IO
import cats.syntax.semigroupk._
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.conflict.ConflictService
import ix.memory.context.ContextService
import ix.memory.db.{ArangoClient, GraphQueryApi, GraphWriteApi}

object Routes {

  def all(
    contextService:  ContextService,
    queryApi:        GraphQueryApi,
    writeApi:        GraphWriteApi,
    conflictService: ConflictService,
    client:          ArangoClient
  ): HttpRoutes[IO] = {

    val health = HttpRoutes.of[IO] {
      case GET -> Root / "v1" / "health" =>
        Ok(Json.obj("status" -> "ok".asJson))
    }

    val contextRoutes       = new ContextRoutes(contextService).routes
    val entityRoutes        = new EntityRoutes(queryApi).routes
    val diffRoutes          = new DiffRoutes(queryApi).routes
    val conflictRoutes      = new ConflictRoutes(conflictService).routes
    val decideRoutes        = new DecideRoutes(writeApi).routes
    val searchRoutes        = new SearchRoutes(queryApi).routes
    val truthRoutes         = new TruthRoutes(writeApi, queryApi).routes
    val patchRoutes         = new PatchRoutes(client).routes
    val decisionListRoutes  = new DecisionRoutes(queryApi).routes
    val expandRoutes        = new ExpandRoutes(queryApi).routes
    val statsRoutes         = new StatsRoutes(client).routes
    val patchCommitRoutes   = new PatchCommitRoutes(writeApi).routes
    val listRoutes          = new ListRoutes(queryApi).routes

    health <+> contextRoutes <+> entityRoutes <+>
      diffRoutes <+> conflictRoutes <+> decideRoutes <+> searchRoutes <+>
      truthRoutes <+> patchRoutes <+> decisionListRoutes <+> expandRoutes <+>
      statsRoutes <+> patchCommitRoutes <+> listRoutes
  }
}
