package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.ArcadeClient

class ArcadeStatsRoutes(client: ArcadeClient) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "stats" =>
      (for {
        nodeStats <- client.query(
          "SELECT kind, count(*) as cnt FROM ix_nodes WHERE deleted_rev IS NULL GROUP BY kind ORDER BY cnt DESC",
          Map.empty[String, AnyRef]
        )
        edgeStats <- client.query(
          "SELECT predicate, count(*) as cnt FROM ix_edges WHERE deleted_rev IS NULL GROUP BY predicate ORDER BY cnt DESC",
          Map.empty[String, AnyRef]
        )
        totalNodes <- client.query(
          "SELECT count(*) as total FROM ix_nodes WHERE deleted_rev IS NULL",
          Map.empty[String, AnyRef]
        )
        totalEdges <- client.query(
          "SELECT count(*) as total FROM ix_edges WHERE deleted_rev IS NULL",
          Map.empty[String, AnyRef]
        )
        resp <- Ok(Json.obj(
          "nodes" -> Json.obj(
            "total" -> totalNodes.headOption
              .flatMap(_.hcursor.downField("total").as[Int].toOption)
              .getOrElse(0).asJson,
            "byKind" -> nodeStats.asJson
          ),
          "edges" -> Json.obj(
            "total" -> totalEdges.headOption
              .flatMap(_.hcursor.downField("total").as[Int].toOption)
              .getOrElse(0).asJson,
            "byPredicate" -> edgeStats.asJson
          )
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
