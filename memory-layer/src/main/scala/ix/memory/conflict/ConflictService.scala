package ix.memory.conflict

import cats.effect.IO
import cats.syntax.traverse._
import ix.memory.db.{ArangoClient, GraphQueryApi, GraphWriteApi}
import ix.memory.model._
import ix.memory.context.ConflictDetector

class ConflictService(client: ArangoClient, queryApi: GraphQueryApi, writeApi: GraphWriteApi) {

  def detectAndStore(claims: Vector[ScoredClaim],
                     detector: ConflictDetector): IO[Vector[ConflictReport]] = {
    val reports = detector.detect(claims)
    // Store conflict sets in DB for each report
    reports.traverse { report =>
      storeConflictSet(report).map(_ => report)
    }
  }

  private def storeConflictSet(report: ConflictReport): IO[Unit] = {
    client.execute(
      """INSERT {
        |  _key: @key,
        |  id: @id,
        |  reason: @reason,
        |  status: "open",
        |  candidate_claims: @candidates,
        |  winner_claim_id: null,
        |  created_rev: 0
        |} INTO conflict_sets OPTIONS { overwriteMode: "ignore" }""".stripMargin,
      Map(
        "key" -> report.id.value.toString.asInstanceOf[AnyRef],
        "id" -> report.id.value.toString.asInstanceOf[AnyRef],
        "reason" -> report.reason.asInstanceOf[AnyRef],
        "candidates" -> java.util.Arrays.asList(
          report.claimA.value.toString, report.claimB.value.toString
        ).asInstanceOf[AnyRef]
      )
    )
  }

  def listConflicts(status: Option[ConflictStatus] = None): IO[Vector[ConflictSet]] = {
    val statusFilter = status.map(_ => " FILTER cs.status == @status").getOrElse("")
    val statusVar: Map[String, AnyRef] = status.map { s =>
      val str = s match {
        case ConflictStatus.Open => "open"
        case ConflictStatus.Resolved => "resolved"
        case ConflictStatus.Dismissed => "dismissed"
      }
      Map("status" -> str.asInstanceOf[AnyRef])
    }.getOrElse(Map.empty)

    client.query(
      s"""FOR cs IN conflict_sets
         |  $statusFilter
         |  RETURN cs""".stripMargin,
      statusVar
    ).map(_.flatMap(parseConflictSet).toVector)
  }

  def resolve(conflictId: ConflictId, winnerClaimId: ClaimId): IO[Unit] = {
    client.execute(
      """FOR cs IN conflict_sets
        |  FILTER cs._key == @key
        |  UPDATE cs WITH { status: "resolved", winner_claim_id: @winner } IN conflict_sets""".stripMargin,
      Map(
        "key" -> conflictId.value.toString.asInstanceOf[AnyRef],
        "winner" -> winnerClaimId.value.toString.asInstanceOf[AnyRef]
      )
    )
  }

  private def parseConflictSet(json: io.circe.Json): Option[ConflictSet] = {
    val c = json.hcursor
    for {
      idStr <- c.get[String]("id").toOption
      id <- scala.util.Try(java.util.UUID.fromString(idStr)).toOption.map(ConflictId(_))
      reason <- c.get[String]("reason").toOption
      statusStr <- c.get[String]("status").toOption
      status = statusStr match {
        case "resolved" => ConflictStatus.Resolved
        case "dismissed" => ConflictStatus.Dismissed
        case _ => ConflictStatus.Open
      }
      candidates <- c.get[Vector[String]]("candidate_claims").toOption
      candidateIds = candidates.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(ClaimId(_)))
      winnerStr = c.get[String]("winner_claim_id").toOption
      winnerId = winnerStr.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(ClaimId(_)))
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
    } yield ConflictSet(id, reason, status, candidateIds, winnerId, createdRev)
  }
}
