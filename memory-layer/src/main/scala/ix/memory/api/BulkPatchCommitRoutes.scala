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

  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

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
