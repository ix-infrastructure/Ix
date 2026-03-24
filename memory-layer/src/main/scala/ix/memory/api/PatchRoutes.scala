package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.syntax._
import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._
import org.http4s.dsl.impl.OptionalQueryParamDecoderMatcher

import ix.memory.db.{ArangoClient, GraphQueryApi}

object LimitParam extends OptionalQueryParamDecoderMatcher[Int]("limit")

case class SourceHashesRequest(uris: List[String])
object SourceHashesRequest {
  implicit val decoder: Decoder[SourceHashesRequest] = deriveDecoder
  implicit val encoder: Encoder[SourceHashesRequest] = deriveEncoder
}

class PatchRoutes(client: ArangoClient, queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "patches" :? LimitParam(limit) =>
      val maxResults = limit.getOrElse(50)
      (for {
        patches <- client.query(
          """FOR p IN patches
            |  SORT p.rev DESC
            |  LIMIT @limit
            |  RETURN { patch_id: p.patch_id, rev: p.rev, intent: p.data.intent,
            |           source_uri: p.data.source.uri, timestamp: p.data.timestamp }""".stripMargin,
          Map("limit" -> Int.box(maxResults).asInstanceOf[AnyRef])
        )
        resp <- Ok(patches.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case GET -> Root / "v1" / "patches" / patchIdStr =>
      (for {
        _       <- IO.fromOption(
          scala.util.Try(UUID.fromString(patchIdStr)).toOption
        )(new IllegalArgumentException(s"Invalid patch ID: $patchIdStr"))
        result  <- client.queryOne(
          """FOR p IN patches
            |  FILTER p.patch_id == @patchId
            |  RETURN p""".stripMargin,
          Map("patchId" -> patchIdStr.asInstanceOf[AnyRef])
        )
        patch   <- IO.fromOption(result)(
          new NoSuchElementException(s"Patch not found: $patchIdStr")
        )
        resp    <- Ok(patch)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case req @ POST -> Root / "v1" / "source-hashes" =>
      (for {
        body    <- req.as[SourceHashesRequest]
        hashes  <- queryApi.getSourceHashes(body.uris)
        resp    <- Ok(hashes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
