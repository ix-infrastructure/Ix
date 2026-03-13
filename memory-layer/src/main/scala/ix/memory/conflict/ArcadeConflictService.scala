package ix.memory.conflict

import cats.effect.IO
import cats.syntax.traverse._
import ix.memory.db.{ArcadeClient, GraphQueryApi, GraphWriteApi}
import ix.memory.model._
import ix.memory.context.ConflictDetector

class ArcadeConflictService(client: ArcadeClient, queryApi: GraphQueryApi, writeApi: GraphWriteApi) {

  def detectAndStore(claims: Vector[ScoredClaim],
                     detector: ConflictDetector): IO[Vector[ConflictReport]] = {
    val reports = detector.detect(claims)
    reports.traverse { report =>
      storeConflictSet(report).map(_ => report)
    }
  }

  private def storeConflictSet(report: ConflictReport): IO[Unit] = {
    // Check if already exists
    client.queryOne(
      "SELECT FROM ix_conflict_sets WHERE id = :id",
      Map("id" -> report.id.value.toString.asInstanceOf[AnyRef])
    ).flatMap {
      case Some(_) => IO.unit // already exists, ignore
      case None =>
        val candidates = s"[\"${report.claimA.value.toString}\",\"${report.claimB.value.toString}\"]"
        client.command(
          """INSERT INTO ix_conflict_sets SET id = :id, reason = :reason, status = 'open', candidate_claims = :candidates, winner_claim_id = NULL, created_rev = 0""",
          Map(
            "id"         -> report.id.value.toString.asInstanceOf[AnyRef],
            "reason"     -> report.reason.asInstanceOf[AnyRef],
            "candidates" -> candidates.asInstanceOf[AnyRef]
          )
        )
    }
  }

  def listConflicts(status: Option[ConflictStatus] = None): IO[Vector[ConflictSet]] = {
    val (sql, params) = status match {
      case Some(s) =>
        val str = s match {
          case ConflictStatus.Open      => "open"
          case ConflictStatus.Resolved  => "resolved"
          case ConflictStatus.Dismissed => "dismissed"
        }
        ("SELECT FROM ix_conflict_sets WHERE status = :status", Map("status" -> str.asInstanceOf[AnyRef]))
      case None =>
        ("SELECT FROM ix_conflict_sets", Map.empty[String, AnyRef])
    }
    client.query(sql, params).map(_.flatMap(parseConflictSet).toVector)
  }

  def resolve(conflictId: ConflictId, winnerClaimId: ClaimId): IO[Unit] = {
    client.command(
      "UPDATE ix_conflict_sets SET status = 'resolved', winner_claim_id = :winner WHERE id = :id",
      Map(
        "id"     -> conflictId.value.toString.asInstanceOf[AnyRef],
        "winner" -> winnerClaimId.value.toString.asInstanceOf[AnyRef]
      )
    )
  }

  private def parseConflictSet(json: io.circe.Json): Option[ConflictSet] = {
    val c = json.hcursor
    for {
      idStr  <- c.get[String]("id").toOption
      id     <- scala.util.Try(java.util.UUID.fromString(idStr)).toOption.map(ConflictId(_))
      reason <- c.get[String]("reason").toOption
      statusStr <- c.get[String]("status").toOption
      status = statusStr match {
        case "resolved"  => ConflictStatus.Resolved
        case "dismissed" => ConflictStatus.Dismissed
        case _           => ConflictStatus.Open
      }
      candidates <- c.get[Vector[String]]("candidate_claims").toOption
      candidateIds = candidates.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(ClaimId(_)))
      winnerStr = c.get[String]("winner_claim_id").toOption
      winnerId  = winnerStr.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(ClaimId(_)))
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
    } yield ConflictSet(id, reason, status, candidateIds, winnerId, createdRev)
  }
}
