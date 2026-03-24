package ix.memory.api

import cats.effect.IO
import io.circe.Json
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.map.MapService

class MapRoutes(mapService: MapService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** POST /v1/map — Run the full map pipeline and return the hierarchy. */
    case req @ POST -> Root / "v1" / "map" =>
      (for {
        body    <- req.as[Json].handleError(_ => Json.obj())
        force    = body.hcursor.get[Boolean]("full").toOption.getOrElse(false)
        archMap <- mapService.buildMap(forceRecompute = force)
        resp    <- Ok(MapEncoder.encodeMap(archMap))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
