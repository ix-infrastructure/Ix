package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.ArangoClient

class PatchRoutes(client: ArangoClient) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "patches" =>
      (for {
        patches <- client.query(
          """FOR p IN patches
            |  SORT p.rev DESC
            |  LIMIT 50
            |  RETURN { patch_id: p.patch_id, rev: p.rev, intent: p.data.intent,
            |           source_uri: p.data.source.uri, timestamp: p.data.timestamp }""".stripMargin,
          Map.empty[String, AnyRef]
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
  }
}
