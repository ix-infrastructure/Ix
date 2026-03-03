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

import ix.memory.db.{GraphQueryApi, GraphWriteApi}
import ix.memory.model._

case class IntentRequest(statement: String, parentIntent: Option[String] = None)

object IntentRequest {
  implicit val decoder: Decoder[IntentRequest] = deriveDecoder[IntentRequest]
}

class TruthRoutes(writeApi: GraphWriteApi, queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "truth" =>
      (for {
        intents <- queryApi.findNodesByKind(NodeKind.Intent)
        resp    <- Ok(intents.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case req @ POST -> Root / "v1" / "truth" =>
      (for {
        body    <- req.as[IntentRequest]
        nodeId   = NodeId(UUID.randomUUID())
        patch    = GraphPatch(
          patchId   = PatchId(UUID.randomUUID()),
          actor     = "ix/api",
          timestamp = Instant.now(),
          source    = PatchSource("api:///v1/truth", None, "user-intent", SourceType.Human),
          baseRev   = Rev(0L),
          ops       = Vector(
            PatchOp.UpsertNode(nodeId, NodeKind.Intent, body.statement, Map(
              "statement"     -> Json.fromString(body.statement),
              "status"        -> Json.fromString("active"),
              "parent_intent" -> body.parentIntent.fold(Json.Null)(Json.fromString)
            ))
          ),
          replaces  = Vector.empty,
          intent    = Some(s"Intent: ${body.statement}")
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
