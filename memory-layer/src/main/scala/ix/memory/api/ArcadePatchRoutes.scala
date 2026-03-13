package ix.memory.api

import java.util.UUID

import cats.effect.IO
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.ArcadeClient

class ArcadePatchRoutes(client: ArcadeClient) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "patches" :? LimitParam(limit) =>
      val maxResults = limit.getOrElse(50)
      (for {
        patches <- client.query(
          "SELECT patch_id, rev, data FROM ix_patches ORDER BY rev DESC LIMIT :limit",
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
          "SELECT FROM ix_patches WHERE patch_id = :patchId",
          Map("patchId" -> patchIdStr.asInstanceOf[AnyRef])
        )
        patch   <- IO.fromOption(result)(
          new NoSuchElementException(s"Patch not found: $patchIdStr")
        )
        resp    <- Ok(patch)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
