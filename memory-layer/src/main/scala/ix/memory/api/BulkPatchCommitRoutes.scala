package ix.memory.api

import cats.effect.IO
import io.circe.{Decoder, Json}
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.{BulkWriteApi, FileBatch, GraphQueryApi}
import ix.memory.model.GraphPatch

class BulkPatchCommitRoutes(bulkWriteApi: BulkWriteApi, queryApi: GraphQueryApi) {

  private case class BulkPatchRequest(patches: List[GraphPatch])
  private implicit val reqDecoder: Decoder[BulkPatchRequest] = deriveDecoder

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "patches" / "bulk" =>
      (for {
        body <- req.as[BulkPatchRequest]
        _    <- if (body.patches.isEmpty)
                  IO.raiseError(new IllegalArgumentException("patches array must not be empty"))
                else IO.unit
        fileBatches = body.patches.map { patch =>
          FileBatch(
            filePath   = patch.source.uri,
            sourceHash = patch.source.sourceHash,
            patch      = patch,
            provenance = buildProvenanceMap(patch)
          )
        }.toVector
        latestRev <- queryApi.getLatestRev
        result    <- bulkWriteApi.commitBatchChunked(fileBatches, latestRev.value)
        resp      <- Ok(Json.obj(
          "status" -> result.status.toString.asJson,
          "rev"    -> result.newRev.value.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def buildProvenanceMap(patch: GraphPatch): java.util.Map[String, AnyRef] = {
    val result = new java.util.HashMap[String, AnyRef](5)
    result.put("source_uri", patch.source.uri)
    result.put("source_hash", patch.source.sourceHash.orNull)
    result.put("extractor", patch.source.extractor)
    result.put("source_type", patch.source.sourceType.asJson.asString.getOrElse("code"))
    result.put("observed_at", patch.timestamp.toString)
    result
  }
}
