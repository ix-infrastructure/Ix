package ix.memory.api

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import io.circe.{Decoder, Json}
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphWriteApi
import ix.memory.model._

case class DecideRequest(title: String, rationale: String, intentId: Option[String] = None)

object DecideRequest {
  implicit val decoder: Decoder[DecideRequest] = deriveDecoder[DecideRequest]
}

class DecideRoutes(writeApi: GraphWriteApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "decide" =>
      (for {
        body    <- req.as[DecideRequest]
        nodeId   = NodeId(UUID.randomUUID())
        patch    = GraphPatch(
          patchId   = PatchId(UUID.randomUUID()),
          actor     = "ix/api",
          timestamp = Instant.now(),
          source    = PatchSource("api:///v1/decide", None, "user-decision", SourceType.Human),
          baseRev   = Rev(0L),
          ops       = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Decision, body.title, Map(
              "title"     -> Json.fromString(body.title),
              "rationale" -> Json.fromString(body.rationale),
              "intent_id" -> body.intentId.fold(Json.Null)(Json.fromString)
            ))
          ),
          replaces  = Vector.empty,
          intent    = Some(s"Decision: ${body.title}")
        )
        result  <- writeApi.commitPatch(patch)
        resp    <- Ok(Json.obj(
          "status"   -> result.status.toString.asJson,
          "nodeId"   -> nodeId.value.toString.asJson,
          "rev"      -> result.newRev.value.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
