package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.map.MapService
import ix.memory.subsystem.SubsystemScoringService

class SubsystemRoutes(
  scoringService: SubsystemScoringService,
  mapService: MapService
) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** GET /v1/subsystems/map — retrieve the persisted architecture map or a scoped region view. */
    case req @ GET -> Root / "v1" / "subsystems" / "map" =>
      val params = req.uri.query.params
      val target = params.get("target").map(_.trim).filter(_.nonEmpty)
      val pickRaw = params.get("pick").map(_.trim).filter(_.nonEmpty)
      (for {
        resp <- parsePick(pickRaw) match {
          case Left(message) =>
            BadRequest(Json.obj("error" -> message.asJson))
          case Right(pick) =>
            for {
              archMap <- mapService.loadCachedMap().flatMap {
                case Some(cached) => IO.pure(cached)
                case None         => mapService.getOrBuildMap()
              }
              response <- target match {
                case None =>
                  if (pick.isDefined) {
                    BadRequest(Json.obj("error" -> "--pick requires a target.".asJson))
                  } else {
                    Ok(MapEncoder.encodeMap(archMap))
                  }
                case Some(query) =>
                  val matches = mapService.resolveRegion(archMap, query)
                  if (matches.isEmpty) {
                    NotFound(Json.obj(
                      "error" -> "unknown_target".asJson,
                      "target_query" -> query.asJson,
                      "message" -> s"""No architecture region matched "$query".""".asJson,
                      "suggestions" -> Vector("ix subsystems", "ix map").asJson
                    ))
                  } else {
                    selectMatch(matches, pick) match {
                      case Left(message) =>
                        BadRequest(Json.obj("error" -> message.asJson))
                      case Right(None) =>
                        BadRequest(MapEncoder.encodeAmbiguousTarget(query, matches, region => mapService.parentOf(archMap, region)))
                      case Right(Some(selected)) =>
                        Ok(MapEncoder.encodeScopedView(mapService.scopedView(archMap, selected.region), mapService.isCrossCutting))
                    }
                  }
              }
            } yield response
        }
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    /** POST /v1/subsystems/score — run health scoring and persist claims. */
    case POST -> Root / "v1" / "subsystems" / "score" =>
      (for {
        scores <- scoringService.score()
        resp   <- Ok(Json.obj(
          "count"  -> scores.size.asJson,
          "scores" -> scores.map { s =>
            Json.obj(
              "region_id"    -> s.regionId.asJson,
              "name"         -> s.regionName.asJson,
              "level"        -> s.level.asJson,
              "label_kind"   -> s.labelKind.asJson,
              "file_count"   -> s.fileCount.asJson,
              "health_score" -> s.healthScore.asJson,
              "chunk_density"-> s.chunkDensity.asJson,
              "smell_rate"   -> s.smellRate.asJson,
              "smell_files"  -> s.smellFiles.asJson,
              "total_chunks" -> s.totalChunks.asJson,
              "confidence"   -> s.confidence.asJson,
              "inference_version" -> "subsystem_v1".asJson
            )
          }.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    /** GET /v1/subsystems — retrieve stored health scores. */
    case GET -> Root / "v1" / "subsystems" =>
      (for {
        scores <- scoringService.listScores()
        resp   <- Ok(Json.obj("scores" -> scores.asJson))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def parsePick(pick: Option[String]): Either[String, Option[Int]] =
    pick match {
      case None => Right(None)
      case Some(value) =>
        scala.util.Try(value.toInt).toOption match {
          case Some(parsed) if parsed > 0 => Right(Some(parsed))
          case _                          => Left("Invalid --pick value.")
        }
    }

  private def selectMatch(matches: Vector[ix.memory.map.RegionMatch], pick: Option[Int]): Either[String, Option[ix.memory.map.RegionMatch]] =
    pick match {
      case None if matches.size == 1 => Right(matches.headOption)
      case None                      => Right(None)
      case Some(index) if index <= matches.size =>
        Right(matches.lift(index - 1))
      case Some(index) =>
        Left(s"Invalid --pick value: $index\nThere are only ${matches.size} matches for the requested target.")
    }
}
