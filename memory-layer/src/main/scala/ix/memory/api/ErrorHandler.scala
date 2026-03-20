package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.{Response, Status}
import org.http4s.circe._
import org.http4s.dsl.io._

import ix.memory.map.MapCapacityException

/**
 * Maps domain exceptions to appropriate HTTP responses with JSON error bodies.
 */
object ErrorHandler {

  def handle(err: Throwable): IO[Response[IO]] = err match {
    case e: MapCapacityException =>
      UnprocessableEntity(mapCapacityJson(e))

    case e: IllegalArgumentException =>
      BadRequest(errorJson("bad_request", e.getMessage))

    case e: NoSuchElementException =>
      NotFound(errorJson("not_found", e.getMessage))

    case e: IllegalStateException =>
      Conflict(errorJson("conflict", e.getMessage))

    case e: UnsupportedOperationException =>
      UnprocessableEntity(errorJson("unprocessable", e.getMessage))

    case e =>
      InternalServerError(errorJson("internal_error", Option(e.getMessage).getOrElse("Unknown error")))
  }

  private def errorJson(code: String, message: String): Json =
    Json.obj(
      "error" -> code.asJson,
      "message" -> message.asJson
    )

  private def mapCapacityJson(e: MapCapacityException): Json =
    Json.obj(
      "error"   -> e.outcome.label.asJson,
      "message" -> e.userMessage.asJson,
      "next"    -> e.next.asJson
    )
}
