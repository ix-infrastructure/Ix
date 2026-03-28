package ix.memory.api

import cats.effect.IO
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._
import org.http4s.dsl.impl.OptionalQueryParamDecoderMatcher

import ix.memory.savings.SavingsAccumulator

object DetailParam extends OptionalQueryParamDecoderMatcher[Boolean]("detail")

class SavingsRoutes(accumulator: SavingsAccumulator) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "v1" / "savings" :? DetailParam(detail) =>
      (for {
        data <- accumulator.getSavings(detail.getOrElse(false))
        resp <- Ok(data.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))

    case DELETE -> Root / "v1" / "savings" =>
      (for {
        _    <- accumulator.reset
        resp <- Ok(io.circe.Json.obj("status" -> "reset".asJson))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
