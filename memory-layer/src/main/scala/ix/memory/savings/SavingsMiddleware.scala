package ix.memory.savings

import cats.data.Kleisli
import cats.effect.IO
import org.http4s.{HttpRoutes, Request, Response}

// Middleware that intercepts responses from /v1/* routes and records
// token savings. Runs as a fire-and-forget side effect.
object SavingsMiddleware {

  // Routes that should not be tracked (meta/health endpoints).
  private val excludedPaths = Set("health", "savings", "stats")

  def apply(
    routes: HttpRoutes[IO],
    accumulator: SavingsAccumulator,
    estimator: NaiveCostEstimator
  ): HttpRoutes[IO] = Kleisli { (req: Request[IO]) =>
    routes(req).semiflatMap { response =>
      extractCommandType(req) match {
        case Some(cmd) if !excludedPaths.contains(cmd) =>
          // Read the response body to measure size, then reconstruct it
          response.body.compile.toVector.flatMap { bodyBytes =>
            val responseChars = bodyBytes.length.toLong
            val recordIO = for {
              naiveEstimate <- estimator.estimate(cmd, responseChars)
              actualTokens   = math.max(1L, responseChars / 4)
              _             <- accumulator.record(cmd, actualTokens, naiveEstimate)
            } yield ()

            // Fire-and-forget: don't let savings tracking failure affect the response
            recordIO.attempt.void.as(
              response.withBodyStream(fs2.Stream.emits(bodyBytes))
            )
          }

        case _ => IO.pure(response)
      }
    }
  }

  // Extract the command type from the request path.
  private def extractCommandType(req: Request[IO]): Option[String] = {
    val segments = req.pathInfo.renderString.stripPrefix("/").split("/").toList
    segments match {
      case "v1" :: cmd :: _ => Some(mapPathToCommand(cmd))
      case _                => None
    }
  }

  // Map URL path segments to logical command names.
  private def mapPathToCommand(segment: String): String = segment match {
    case "context"       => "query"
    case "search"        => "search"
    case "entity"        => "entity"
    case "expand"        => "callers"
    case "expand-by-name"=> "callers"
    case "diff"          => "diff"
    case "conflicts"     => "conflicts"
    case "decide"        => "decide"
    case "truth"         => "truth"
    case "patches"       => "history"
    case "map"           => "map"
    case "list"          => "inventory"
    case "decisions"     => "decisions"
    case "smells"        => "smells"
    case "subsystems"    => "subsystems"
    case "provenance"    => "history"
    case "resolve-prefix"=> "locate"
    case "ingest"        => "map"
    case other           => other
  }
}
