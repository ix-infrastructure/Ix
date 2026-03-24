package ix.memory.api

import cats.effect.IO
import cats.syntax.traverse._
import io.circe.syntax._
import io.circe.Json
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.{BulkWriteApi, CommitResult, CommitStatus, FileBatch, GraphQueryApi, GraphWriteApi}
import ix.memory.model.{GraphPatch, Rev}

class PatchCommitRoutes(writeApi: GraphWriteApi, bulkWriteApi: BulkWriteApi, queryApi: GraphQueryApi) {

  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "patch" =>
      (for {
        patch  <- req.as[GraphPatch]
        result <- writeApi.commitPatch(patch)
        resp   <- Ok(Json.obj(
          "status" -> result.status.toString.asJson,
          "rev"    -> result.newRev.value.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    // Batch endpoint: use BulkWriteApi (bulk document inserts, no per-patch transaction)
    // instead of traverse(commitPatch) which was N serial ArangoDB transactions.
    case req @ POST -> Root / "v1" / "patches" / "batch" =>
      (for {
        patches   <- req.as[Vector[GraphPatch]]
        latestRev <- queryApi.getLatestRev
        result    <- if (patches.isEmpty)
                       IO.pure(CommitResult(latestRev, CommitStatus.Ok))
                     else {
                       val fileBatches = patches.map(p => FileBatch(
                         filePath   = p.source.uri,
                         sourceHash = p.source.sourceHash,
                         patch      = p,
                         provenance = buildProvenanceMap(p)
                       ))
                       bulkWriteApi.commitBatchChunked(fileBatches, latestRev.value)
                     }
        // Return one result entry per patch (same rev for all — one bulk revision)
        resp <- Ok(patches.map(_ => Json.obj(
          "status" -> result.status.toString.asJson,
          "rev"    -> result.newRev.value.asJson
        )).asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def buildProvenanceMap(patch: GraphPatch): java.util.Map[String, AnyRef] = {
    val json = Json.obj(
      "source_uri"  -> Json.fromString(patch.source.uri),
      "source_hash" -> patch.source.sourceHash.fold(Json.Null)(Json.fromString),
      "extractor"   -> Json.fromString(patch.source.extractor),
      "source_type" -> Json.fromString(patch.source.sourceType.asJson.asString.getOrElse("code")),
      "observed_at" -> Json.fromString(patch.timestamp.toString)
    )
    mapper.readValue(json.noSpaces, classOf[java.util.Map[String, AnyRef]])
  }
}
