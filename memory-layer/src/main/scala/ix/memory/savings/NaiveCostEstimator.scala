package ix.memory.savings

import cats.effect.IO
import io.circe.Json

import ix.memory.db.{GraphQueryApi, ArangoClient}
import ix.memory.model._

/**
 * Estimates the "naive" token cost of getting equivalent information without Ix.
 *
 * Uses graph-derived file sizes for entity commands (overview, impact, callers, etc.)
 * and fixed multipliers for search/analysis commands.
 */
class NaiveCostEstimator(queryApi: GraphQueryApi) {

  /** Fixed multipliers per command type, used when graph derivation isn't practical. */
  private val multipliers: Map[String, Int] = Map(
    "search"     -> 6,
    "text"       -> 6,
    "locate"     -> 6,
    "inventory"  -> 8,
    "rank"       -> 8,
    "diff"       -> 5,
    "history"    -> 5,
    "smells"     -> 10,
    "subsystems" -> 10,
  )

  private val defaultMultiplier = 4

  /**
   * Estimate naive token cost for a command.
   *
   * @param commandType the ix command name (e.g., "overview", "search")
   * @param responseChars the character count of the actual response
   * @param entityIds optional entity IDs resolved during the command
   * @return estimated naive token count
   */
  def estimate(
    commandType: String,
    responseChars: Long,
    entityIds: Seq[NodeId] = Seq.empty
  ): IO[Long] = {
    val responseTokens = math.max(1L, responseChars / 4)

    commandType match {
      case "overview" | "explain" =>
        estimateFromGraph(entityIds, depthFactor = 3).map(_.getOrElse(responseTokens * 5))

      case "impact" =>
        estimateFromGraph(entityIds, depthFactor = 4).map(_.getOrElse(responseTokens * 8))

      case "callers" | "callees" | "imported-by" | "imports" =>
        estimateFromGraph(entityIds, depthFactor = 2).map(_.getOrElse(responseTokens * 4))

      case "contains" =>
        estimateFromGraph(entityIds, depthFactor = 1).map(_.getOrElse(responseTokens * 3))

      case "depends" =>
        estimateFromGraph(entityIds, depthFactor = 3).map(_.getOrElse(responseTokens * 6))

      case cmd =>
        val mult = multipliers.getOrElse(cmd, defaultMultiplier)
        IO.pure(responseTokens * mult)
    }
  }

  /**
   * Estimate by summing actual file sizes of involved entities from the graph.
   * Returns None if no entities are available.
   */
  private def estimateFromGraph(entityIds: Seq[NodeId], depthFactor: Int): IO[Option[Long]] = {
    if (entityIds.isEmpty) return IO.pure(None)

    entityIds.toList.foldLeft(IO.pure(0L)) { (accIO, nodeId) =>
      for {
        acc     <- accIO
        nodeOpt <- queryApi.getNode(nodeId)
        size: Long = nodeOpt.map { node =>
          val attrsC = node.attrs.hcursor
          attrsC.get[Long]("line_end").toOption.map(_ * 80L) // estimate chars from line count
            .orElse(attrsC.get[String]("source_uri").toOption.map(_ => 2000L)) // fallback: 2KB per file
            .getOrElse(1000L) // default estimate
        }.getOrElse(1000L)
      } yield acc + size
    }.map { totalChars =>
      val tokens = totalChars / 4 * depthFactor
      Some(math.max(tokens, 100L))
    }
  }
}
