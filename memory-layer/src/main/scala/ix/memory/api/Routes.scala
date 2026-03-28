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
import ix.memory.db.{ArangoClient, BulkWriteApi, GraphQueryApi, GraphWriteApi}
import ix.memory.map.MapService
import ix.memory.savings.SavingsAccumulator
import ix.memory.smell.SmellService
import ix.memory.subsystem.SubsystemScoringService

object Routes {

  def all(
    contextService:       ContextService,
    queryApi:             GraphQueryApi,
    writeApi:             GraphWriteApi,
    conflictService:      ConflictService,
    client:               ArangoClient,
    mapService:           MapService,
    bulkWriteApi:         BulkWriteApi,
    smellService:         SmellService,
    subsystemService:     SubsystemScoringService,
    savingsAccumulator:   SavingsAccumulator
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
    val goalRoutes          = new GoalRoutes(writeApi, queryApi).routes
    val patchRoutes         = new PatchRoutes(client, queryApi).routes
    val decisionListRoutes  = new DecisionRoutes(queryApi).routes
    val expandRoutes        = new ExpandRoutes(queryApi).routes
    val statsRoutes         = new StatsRoutes(client).routes
    val patchCommitRoutes   = new PatchCommitRoutes(writeApi, bulkWriteApi, queryApi).routes
    val listRoutes          = new ListRoutes(queryApi).routes
    val mapRoutes               = new MapRoutes(mapService).routes
    val resetRoutes             = new ResetRoutes(client).routes
    val sourceHashRoutes        = new SourceHashRoutes(queryApi).routes
    val bulkPatchCommitRoutes   = new BulkPatchCommitRoutes(bulkWriteApi, queryApi).routes
    val smellRoutes             = new SmellRoutes(smellService).routes
    val subsystemRoutes         = new SubsystemRoutes(subsystemService, mapService).routes
    val savingsRoutes           = new SavingsRoutes(savingsAccumulator).routes

    health <+> contextRoutes <+> entityRoutes <+>
      diffRoutes <+> conflictRoutes <+> decideRoutes <+> searchRoutes <+>
      truthRoutes <+> patchRoutes <+> decisionListRoutes <+> expandRoutes <+>
      statsRoutes <+> patchCommitRoutes <+> listRoutes <+> goalRoutes <+>
      mapRoutes <+> resetRoutes <+> sourceHashRoutes <+> bulkPatchCommitRoutes <+>
      smellRoutes <+> subsystemRoutes <+> savingsRoutes
  }
}
