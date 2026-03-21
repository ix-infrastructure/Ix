package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.ArangoClient

class ResetRoutes(client: ArangoClient) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** POST /v1/reset — Truncate all graph data (nodes + edges). Dev use only. */
    case POST -> Root / "v1" / "reset" =>
      (for {
        _ <- client.truncateGraph()
        r <- Ok(Json.obj("ok" -> true.asJson, "message" -> "Graph reset. All nodes and edges deleted.".asJson))
      } yield r).handleErrorWith(ErrorHandler.handle(_))
  }
}
