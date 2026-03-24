package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._
import org.http4s.dsl.impl.OptionalQueryParamDecoderMatcher

import ix.memory.smell.{SmellConfig, SmellService}

object OrphanThresholdParam extends OptionalQueryParamDecoderMatcher[Int]("orphan-max-connections")
object GodChunkParam        extends OptionalQueryParamDecoderMatcher[Int]("god-module-chunks")
object GodFanParam          extends OptionalQueryParamDecoderMatcher[Int]("god-module-fan")
object WeakNeighborParam    extends OptionalQueryParamDecoderMatcher[Int]("weak-max-neighbors")

class SmellRoutes(smellService: SmellService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** POST /v1/smells — run smell detection and persist claims. */
    case req @ POST -> Root / "v1" / "smells"
        :? OrphanThresholdParam(orphanMax)
        +& GodChunkParam(godChunks)
        +& GodFanParam(godFan)
        +& WeakNeighborParam(weakNeighbors) =>

      val config = SmellConfig(
        orphanMaxConnections     = orphanMax.getOrElse(0),
        godModuleChunkThreshold  = godChunks.getOrElse(20),
        godModuleFanThreshold    = godFan.getOrElse(15),
        weakComponentMaxNeighbors = weakNeighbors.getOrElse(1)
      )
      (for {
        report <- smellService.run(config)
        resp   <- Ok(Json.obj(
          "rev"        -> report.rev.asJson,
          "run_at"     -> report.runAt.asJson,
          "count"      -> report.candidates.size.asJson,
          "candidates" -> report.candidates.map { c =>
            Json.obj(
              "file_id"    -> c.fileId.asJson,
              "file"       -> c.fileName.asJson,
              "smell"      -> c.smellKind.field.asJson,
              "confidence" -> c.confidence.asJson,
              "signals"    -> c.signals.asJson,
              "inference_version" -> "smell_v1".asJson
            )
          }.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    /** GET /v1/smells — retrieve existing smell claims without rerunning. */
    case GET -> Root / "v1" / "smells" =>
      (for {
        smells <- smellService.listSmells()
        resp   <- Ok(Json.obj("smells" -> smells.asJson))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
