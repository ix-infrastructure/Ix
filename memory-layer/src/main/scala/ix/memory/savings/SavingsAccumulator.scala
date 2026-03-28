package ix.memory.savings

import cats.effect.{IO, Ref}
import io.circe.{Encoder, Json}
import io.circe.syntax._

import ix.memory.db.ArangoClient

/** Tracks token savings per session (in-memory) and lifetime (ArangoDB). */
class SavingsAccumulator(client: ArangoClient, session: Ref[IO, SavingsData]) {

  /** Record savings for a single command invocation. Fire-and-forget safe. */
  def record(commandType: String, actualTokens: Long, naiveEstimate: Long): IO[Unit] = {
    val saved = math.max(0L, naiveEstimate - actualTokens)
    val entry = CommandSavings(count = 1, saved = saved)
    for {
      _ <- session.update(_.add(commandType, actualTokens, naiveEstimate, saved))
      _ <- persistLifetime(commandType, actualTokens, naiveEstimate, saved)
    } yield ()
  }

  /** Get current savings data. */
  def getSavings(detail: Boolean): IO[SavingsResponse] =
    for {
      sess     <- session.get
      lifetime <- loadLifetime
    } yield SavingsResponse(
      session  = if (detail) sess else sess.withoutBreakdown,
      lifetime = if (detail) lifetime else lifetime.withoutBreakdown
    )

  /** Reset lifetime totals. */
  def reset: IO[Unit] =
    for {
      _ <- session.set(SavingsData.empty)
      _ <- client.execute(
        """UPSERT { _key: "lifetime" }
          |INSERT { _key: "lifetime", totalSaved: 0, totalNaive: 0, totalActual: 0,
          |         commandCount: 0, byCommandType: {}, lastUpdated: DATE_ISO8601(DATE_NOW()) }
          |UPDATE { totalSaved: 0, totalNaive: 0, totalActual: 0,
          |         commandCount: 0, byCommandType: {}, lastUpdated: DATE_ISO8601(DATE_NOW()) }
          |IN savings""".stripMargin
      )
    } yield ()

  private def persistLifetime(
    commandType: String, actual: Long, naive: Long, saved: Long
  ): IO[Unit] =
    client.execute(
      """UPSERT { _key: "lifetime" }
        |INSERT { _key: "lifetime", totalSaved: @saved, totalNaive: @naive, totalActual: @actual,
        |         commandCount: 1, byCommandType: { [@cmd]: { count: 1, saved: @saved } },
        |         lastUpdated: DATE_ISO8601(DATE_NOW()) }
        |UPDATE {
        |  totalSaved: OLD.totalSaved + @saved,
        |  totalNaive: OLD.totalNaive + @naive,
        |  totalActual: OLD.totalActual + @actual,
        |  commandCount: OLD.commandCount + 1,
        |  byCommandType: MERGE(OLD.byCommandType, {
        |    [@cmd]: {
        |      count: (HAS(OLD.byCommandType, @cmd) ? OLD.byCommandType[@cmd].count : 0) + 1,
        |      saved: (HAS(OLD.byCommandType, @cmd) ? OLD.byCommandType[@cmd].saved : 0) + @saved
        |    }
        |  }),
        |  lastUpdated: DATE_ISO8601(DATE_NOW())
        |} IN savings""".stripMargin,
      Map(
        "saved" -> Long.box(saved).asInstanceOf[AnyRef],
        "naive" -> Long.box(naive).asInstanceOf[AnyRef],
        "actual" -> Long.box(actual).asInstanceOf[AnyRef],
        "cmd" -> commandType.asInstanceOf[AnyRef]
      )
    )

  private def loadLifetime: IO[SavingsData] =
    client.queryOne(
      """FOR doc IN savings FILTER doc._key == "lifetime" RETURN doc""",
      Map.empty[String, AnyRef]
    ).map {
      case Some(json) =>
        val c = json.hcursor
        val byCmd = c.downField("byCommandType").focus
          .flatMap(_.asObject)
          .map { obj =>
            obj.toMap.map { case (k, v) =>
              val vc = v.hcursor
              k -> CommandSavings(
                count = vc.get[Long]("count").getOrElse(0L),
                saved = vc.get[Long]("saved").getOrElse(0L)
              )
            }
          }.getOrElse(Map.empty)
        SavingsData(
          totalSaved    = c.get[Long]("totalSaved").getOrElse(0L),
          totalNaive    = c.get[Long]("totalNaive").getOrElse(0L),
          totalActual   = c.get[Long]("totalActual").getOrElse(0L),
          commandCount  = c.get[Long]("commandCount").getOrElse(0L),
          byCommandType = byCmd
        )
      case None => SavingsData.empty
    }
}

object SavingsAccumulator {
  def create(client: ArangoClient): IO[SavingsAccumulator] =
    Ref.of[IO, SavingsData](SavingsData.empty).map(new SavingsAccumulator(client, _))
}

case class CommandSavings(count: Long, saved: Long)

object CommandSavings {
  implicit val encoder: Encoder[CommandSavings] = Encoder.forProduct2("count", "saved")(cs =>
    (cs.count, cs.saved))
}

case class SavingsData(
  totalSaved:    Long,
  totalNaive:    Long,
  totalActual:   Long,
  commandCount:  Long,
  byCommandType: Map[String, CommandSavings]
) {
  def add(cmd: String, actual: Long, naive: Long, saved: Long): SavingsData = {
    val existing = byCommandType.getOrElse(cmd, CommandSavings(0, 0))
    copy(
      totalSaved   = totalSaved + saved,
      totalNaive   = totalNaive + naive,
      totalActual  = totalActual + actual,
      commandCount = commandCount + 1,
      byCommandType = byCommandType.updated(cmd,
        CommandSavings(existing.count + 1, existing.saved + saved))
    )
  }

  def withoutBreakdown: SavingsData = copy(byCommandType = Map.empty)
}

object SavingsData {
  val empty: SavingsData = SavingsData(0, 0, 0, 0, Map.empty)

  implicit val encoder: Encoder[SavingsData] = Encoder.forProduct5(
    "commandCount", "tokensSaved", "naiveTokens", "actualTokens", "byCommandType"
  )(d => (d.commandCount, d.totalSaved, d.totalNaive, d.totalActual, d.byCommandType))
}

case class SavingsResponse(session: SavingsData, lifetime: SavingsData)

object SavingsResponse {
  implicit val encoder: Encoder[SavingsResponse] = Encoder.forProduct2("session", "lifetime")(r =>
    (r.session, r.lifetime))
}
