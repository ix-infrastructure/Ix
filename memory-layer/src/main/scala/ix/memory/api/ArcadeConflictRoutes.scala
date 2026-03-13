package ix.memory.api

import java.util.UUID

import cats.effect.IO
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

import ix.memory.conflict.ArcadeConflictService
import ix.memory.model.{ClaimId, ConflictId, ConflictStatus}

case class ResolveRequest(winnerClaimId: String)

object ResolveRequest {
  implicit val decoder: Decoder[ResolveRequest] = deriveDecoder[ResolveRequest]
  implicit val encoder: Encoder[ResolveRequest] = deriveEncoder[ResolveRequest]
}

class ArcadeConflictRoutes(conflictService: ArcadeConflictService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    // GET /v1/conflicts?status=<optional>
    case req @ GET -> Root / "v1" / "conflicts" =>
      val status = req.params.get("status").flatMap(parseStatus)
      (for {
        conflicts <- conflictService.listConflicts(status)
        resp      <- Ok(conflicts)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    // POST /v1/conflicts/:id/resolve
    case req @ POST -> Root / "v1" / "conflicts" / UUIDVar(id) / "resolve" =>
      (for {
        body          <- req.as[ResolveRequest]
        winnerClaimId <- IO.fromTry(scala.util.Try(UUID.fromString(body.winnerClaimId))).map(ClaimId(_))
        conflictId     = ConflictId(id)
        _             <- conflictService.resolve(conflictId, winnerClaimId)
        resp          <- Ok(io.circe.Json.obj("status" -> io.circe.Json.fromString("resolved")))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def parseStatus(s: String): Option[ConflictStatus] = s.toLowerCase match {
    case "open"      => Some(ConflictStatus.Open)
    case "resolved"  => Some(ConflictStatus.Resolved)
    case "dismissed" => Some(ConflictStatus.Dismissed)
    case _           => None
  }
}
