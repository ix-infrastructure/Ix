package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.implicits._
import io.circe.syntax._
import io.circe.Json

import ix.memory.model._

class ArcadeGraphWriteApi(client: ArcadeClient) extends GraphWriteApi {

  // ── Public entry point ────────────────────────────────────────────

  override def commitPatch(patch: GraphPatch): IO[CommitResult] =
    for {
      // Step 1: Check idempotency
      idempotent <- checkIdempotency(patch.patchId)
      result     <- idempotent match {
        case Some(storedRev) =>
          IO.pure(CommitResult(storedRev, CommitStatus.Idempotent))
        case None =>
          doCommit(patch)
      }
    } yield result

  // ── Private helpers ───────────────────────────────────────────────

  private def checkIdempotency(patchId: PatchId): IO[Option[Rev]] =
    client.queryOne(
      "SELECT rev FROM ix_idempotency_keys WHERE key = :key",
      Map("key" -> idempotencyKey(patchId).asInstanceOf[AnyRef])
    ).map(_.flatMap(_.hcursor.downField("rev").as[Long].toOption).map(Rev(_)))

  private def idempotencyKey(patchId: PatchId): String =
    patchId.value.toString

  private def doCommit(patch: GraphPatch): IO[CommitResult] =
    for {
      // Step 2: Load latest rev
      latestRev <- loadLatestRev()

      // Step 3: Check baseRev
      result <- {
        if (patch.baseRev.value > 0L && patch.baseRev.value != latestRev) {
          IO.pure(CommitResult(Rev(latestRev), CommitStatus.BaseRevMismatch))
        } else {
          val newRev = latestRev + 1L
          for {
            // Step 5: Execute each op
            _ <- patch.ops.traverse_(op => executeOp(op, patch, newRev))
            // Step 6: Retire absent claims
            _ <- retireAbsentClaims(patch, newRev)
            // Step 7: Store patch
            _ <- storePatch(patch, newRev)
            // Step 8: Store idempotency key
            _ <- storeIdempotencyKey(patch.patchId, newRev)
            // Step 9: Update revision
            _ <- updateRevision(newRev)
          } yield CommitResult(Rev(newRev), CommitStatus.Ok)
        }
      }
    } yield result

  private def loadLatestRev(): IO[Long] =
    client.queryOne(
      "SELECT rev FROM ix_revisions WHERE key = :key",
      Map("key" -> "current".asInstanceOf[AnyRef])
    ).map(_.flatMap(_.hcursor.downField("rev").as[Long].toOption).getOrElse(0L))

  private def executeOp(op: PatchOp, patch: GraphPatch, newRev: Long): IO[Unit] = op match {

    case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val logicalId = id.value.toString
      val now = Instant.now().toString
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces

      for {
        existing <- client.queryOne(
          "SELECT FROM ix_nodes WHERE logical_id = :logicalId AND deleted_rev IS NULL",
          Map("logicalId" -> logicalId.asInstanceOf[AnyRef])
        )
        _ <- existing match {
          case Some(existingJson) =>
            val existingAttrsStr = existingJson.hcursor.downField("attrs").focus
              .map(j => if (j.isString) j.asString.getOrElse("{}") else j.noSpaces)
              .getOrElse("{}")
            if (existingAttrsStr == attrsJson) {
              IO.unit // idempotent no-op
            } else {
              // Tombstone old row + insert new
              val existingRid = existingJson.hcursor.downField("@rid").as[String].toOption
              existingRid match {
                case Some(rid) =>
                  for {
                    _ <- client.command(
                      s"UPDATE $rid SET deleted_rev = :rev, updated_at = :now",
                      Map(
                        "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
                        "now" -> now.asInstanceOf[AnyRef]
                      )
                    )
                    _ <- insertNode(logicalId, kind, name, attrsJson, patch, newRev, now)
                  } yield ()
                case None =>
                  // Fallback: update by logical_id
                  for {
                    _ <- client.command(
                      "UPDATE ix_nodes SET deleted_rev = :rev, updated_at = :now WHERE logical_id = :logicalId AND deleted_rev IS NULL",
                      Map(
                        "rev"       -> Long.box(newRev).asInstanceOf[AnyRef],
                        "now"       -> now.asInstanceOf[AnyRef],
                        "logicalId" -> logicalId.asInstanceOf[AnyRef]
                      )
                    )
                    _ <- insertNode(logicalId, kind, name, attrsJson, patch, newRev, now)
                  } yield ()
              }
            }

          case None =>
            insertNode(logicalId, kind, name, attrsJson, patch, newRev, now)
        }
      } yield ()

    case PatchOp.UpsertEdge(id, src, dst, predicate, attrs) =>
      val edgeId = id.value.toString
      val now = Instant.now().toString
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      val provenanceJson = buildProvenance(patch).noSpaces

      for {
        existing <- client.queryOne(
          "SELECT FROM ix_edges WHERE edge_id = :edgeId",
          Map("edgeId" -> edgeId.asInstanceOf[AnyRef])
        )
        _ <- existing match {
          case Some(existingJson) =>
            val rid = existingJson.hcursor.downField("@rid").as[String].toOption
            rid match {
              case Some(r) =>
                client.command(
                  s"UPDATE $r SET src = :src, dst = :dst, predicate = :pred, attrs = :attrs, deleted_rev = NULL, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, updated_at = :now",
                  Map(
                    "src"         -> src.value.toString.asInstanceOf[AnyRef],
                    "dst"         -> dst.value.toString.asInstanceOf[AnyRef],
                    "pred"        -> predicate.value.asInstanceOf[AnyRef],
                    "attrs"       -> attrsJson.asInstanceOf[AnyRef],
                    "source_uri"  -> patch.source.uri.asInstanceOf[AnyRef],
                    "source_hash" -> patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
                    "extractor"   -> patch.source.extractor.asInstanceOf[AnyRef],
                    "source_type" -> sourceTypeToString(patch.source.sourceType).asInstanceOf[AnyRef],
                    "now"         -> now.asInstanceOf[AnyRef]
                  )
                )
              case None =>
                client.command(
                  "UPDATE ix_edges SET src = :src, dst = :dst, predicate = :pred, attrs = :attrs, deleted_rev = NULL, updated_at = :now WHERE edge_id = :edgeId",
                  Map(
                    "edgeId" -> edgeId.asInstanceOf[AnyRef],
                    "src"    -> src.value.toString.asInstanceOf[AnyRef],
                    "dst"    -> dst.value.toString.asInstanceOf[AnyRef],
                    "pred"   -> predicate.value.asInstanceOf[AnyRef],
                    "attrs"  -> attrsJson.asInstanceOf[AnyRef],
                    "now"    -> now.asInstanceOf[AnyRef]
                  )
                )
            }

          case None =>
            client.command(
              """INSERT INTO ix_edges SET edge_id = :edgeId, src = :src, dst = :dst, predicate = :pred, attrs = :attrs, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL, created_at = :now, updated_at = :now""",
              Map(
                "edgeId"      -> edgeId.asInstanceOf[AnyRef],
                "src"         -> src.value.toString.asInstanceOf[AnyRef],
                "dst"         -> dst.value.toString.asInstanceOf[AnyRef],
                "pred"        -> predicate.value.asInstanceOf[AnyRef],
                "attrs"       -> attrsJson.asInstanceOf[AnyRef],
                "source_uri"  -> patch.source.uri.asInstanceOf[AnyRef],
                "source_hash" -> patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
                "extractor"   -> patch.source.extractor.asInstanceOf[AnyRef],
                "source_type" -> sourceTypeToString(patch.source.sourceType).asInstanceOf[AnyRef],
                "rev"         -> Long.box(newRev).asInstanceOf[AnyRef],
                "now"         -> now.asInstanceOf[AnyRef]
              )
            )
        }
      } yield ()

    case PatchOp.DeleteNode(id) =>
      client.command(
        "UPDATE ix_nodes SET deleted_rev = :rev WHERE logical_id = :logicalId AND deleted_rev IS NULL",
        Map(
          "logicalId" -> id.value.toString.asInstanceOf[AnyRef],
          "rev"       -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )

    case PatchOp.DeleteEdge(id) =>
      client.command(
        "UPDATE ix_edges SET deleted_rev = :rev WHERE edge_id = :edgeId AND deleted_rev IS NULL",
        Map(
          "edgeId" -> id.value.toString.asInstanceOf[AnyRef],
          "rev"    -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )

    case PatchOp.AssertClaim(entityId, field, value, confidence) =>
      val provenanceJson = buildProvenance(patch).noSpaces
      val valueStr = value.noSpaces
      for {
        // Retire conflicting claims with different value
        _ <- client.command(
          "UPDATE ix_claims SET status = 'retired', deleted_rev = :rev WHERE entity_id = :eid AND field = :field AND deleted_rev IS NULL AND value <> :val",
          Map(
            "eid"   -> entityId.value.toString.asInstanceOf[AnyRef],
            "field" -> field.asInstanceOf[AnyRef],
            "val"   -> valueStr.asInstanceOf[AnyRef],
            "rev"   -> Long.box(newRev).asInstanceOf[AnyRef]
          )
        )
        // Check for duplicate
        dup <- client.queryOne(
          "SELECT FROM ix_claims WHERE entity_id = :eid AND field = :field AND value = :val AND deleted_rev IS NULL",
          Map(
            "eid"   -> entityId.value.toString.asInstanceOf[AnyRef],
            "field" -> field.asInstanceOf[AnyRef],
            "val"   -> valueStr.asInstanceOf[AnyRef]
          )
        )
        _ <- if (dup.isDefined) IO.unit
             else {
               val confValue = confidence.map(Double.box).orNull
               client.command(
                 """INSERT INTO ix_claims SET entity_id = :eid, field = :field, value = :val, status = 'active', confidence = :conf, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL""",
                 Map(
                   "eid"         -> entityId.value.toString.asInstanceOf[AnyRef],
                   "field"       -> field.asInstanceOf[AnyRef],
                   "val"         -> valueStr.asInstanceOf[AnyRef],
                   "conf"        -> confValue.asInstanceOf[AnyRef],
                   "source_uri"  -> patch.source.uri.asInstanceOf[AnyRef],
                   "source_hash" -> patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
                   "extractor"   -> patch.source.extractor.asInstanceOf[AnyRef],
                   "source_type" -> sourceTypeToString(patch.source.sourceType).asInstanceOf[AnyRef],
                   "rev"         -> Long.box(newRev).asInstanceOf[AnyRef]
                 )
               )
             }
      } yield ()

    case PatchOp.RetractClaim(claimId) =>
      client.command(
        "UPDATE ix_claims SET status = 'retracted', deleted_rev = :rev WHERE entity_id = :eid AND deleted_rev IS NULL",
        Map(
          "eid" -> claimId.value.toString.asInstanceOf[AnyRef],
          "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )
  }

  private def insertNode(
    logicalId: String,
    kind: NodeKind,
    name: String,
    attrsJson: String,
    patch: GraphPatch,
    newRev: Long,
    now: String
  ): IO[Unit] =
    client.command(
      """INSERT INTO ix_nodes SET logical_id = :logicalId, kind = :kind, name = :name, attrs = :attrs, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL, created_at = :now, updated_at = :now""",
      Map(
        "logicalId"   -> logicalId.asInstanceOf[AnyRef],
        "kind"        -> nodeKindToString(kind).asInstanceOf[AnyRef],
        "name"        -> name.asInstanceOf[AnyRef],
        "attrs"       -> attrsJson.asInstanceOf[AnyRef],
        "source_uri"  -> patch.source.uri.asInstanceOf[AnyRef],
        "source_hash" -> patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
        "extractor"   -> patch.source.extractor.asInstanceOf[AnyRef],
        "source_type" -> sourceTypeToString(patch.source.sourceType).asInstanceOf[AnyRef],
        "rev"         -> Long.box(newRev).asInstanceOf[AnyRef],
        "now"         -> now.asInstanceOf[AnyRef]
      )
    )

  private def storePatch(patch: GraphPatch, newRev: Long): IO[Unit] = {
    val patchJson = patch.asJson.noSpaces
    client.command(
      """INSERT INTO ix_patches SET patch_id = :patch_id, rev = :rev, data = :data""",
      Map(
        "patch_id" -> patch.patchId.value.toString.asInstanceOf[AnyRef],
        "rev"      -> Long.box(newRev).asInstanceOf[AnyRef],
        "data"     -> patchJson.asInstanceOf[AnyRef]
      )
    )
  }

  private def storeIdempotencyKey(patchId: PatchId, newRev: Long): IO[Unit] =
    client.command(
      """INSERT INTO ix_idempotency_keys SET key = :key, rev = :rev, created_at = :now""",
      Map(
        "key" -> idempotencyKey(patchId).asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
        "now" -> Instant.now().toString.asInstanceOf[AnyRef]
      )
    )

  private def updateRevision(newRev: Long): IO[Unit] =
    for {
      existing <- client.queryOne(
        "SELECT FROM ix_revisions WHERE key = :key",
        Map("key" -> "current".asInstanceOf[AnyRef])
      )
      _ <- existing match {
        case Some(json) =>
          val rid = json.hcursor.downField("@rid").as[String].toOption
          rid match {
            case Some(r) =>
              client.command(
                s"UPDATE $r SET rev = :rev",
                Map("rev" -> Long.box(newRev).asInstanceOf[AnyRef])
              )
            case None =>
              client.command(
                "UPDATE ix_revisions SET rev = :rev WHERE key = :key",
                Map(
                  "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
                  "key" -> "current".asInstanceOf[AnyRef]
                )
              )
          }
        case None =>
          client.command(
            """INSERT INTO ix_revisions SET key = :key, rev = :rev""",
            Map(
              "key" -> "current".asInstanceOf[AnyRef],
              "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
            )
          )
      }
    } yield ()

  private def retireAbsentClaims(patch: GraphPatch, newRev: Long): IO[Unit] = {
    val assertedClaims = patch.ops.collect {
      case PatchOp.AssertClaim(entityId, field, _, _) => (entityId.value.toString, field)
    }

    if (assertedClaims.isEmpty) IO.unit
    else {
      val fieldsByEntity: Map[String, Set[String]] = assertedClaims
        .groupBy(_._1)
        .map { case (eid, pairs) => eid -> pairs.map(_._2).toSet }

      val extractor = patch.source.extractor

      fieldsByEntity.toVector.traverse_ { case (entityId, fields) =>
        // For each entity, find claims from same extractor whose field is NOT in the patch
        // ArcadeDB does not support NOT IN with params well, so we query all and filter
        client.query(
          "SELECT FROM ix_claims WHERE entity_id = :eid AND deleted_rev IS NULL AND extractor = :extractor",
          Map(
            "eid"       -> entityId.asInstanceOf[AnyRef],
            "extractor" -> extractor.asInstanceOf[AnyRef]
          )
        ).flatMap { claims =>
          claims.traverse_ { claimJson =>
            val claimField = claimJson.hcursor.downField("field").as[String].toOption
            val rid = claimJson.hcursor.downField("@rid").as[String].toOption
            (claimField, rid) match {
              case (Some(f), Some(r)) if !fields.contains(f) =>
                client.command(
                  s"UPDATE $r SET status = 'stale', deleted_rev = :rev",
                  Map("rev" -> Long.box(newRev).asInstanceOf[AnyRef])
                )
              case _ => IO.unit
            }
          }
        }
      }
    }
  }

  private def buildProvenance(patch: GraphPatch): Json =
    Json.obj(
      "source_uri"  -> Json.fromString(patch.source.uri),
      "source_hash" -> patch.source.sourceHash.fold(Json.Null)(Json.fromString),
      "extractor"   -> Json.fromString(patch.source.extractor),
      "source_type" -> Json.fromString(sourceTypeToString(patch.source.sourceType)),
      "observed_at" -> Json.fromString(patch.timestamp.toString)
    )

  private def sourceTypeToString(st: SourceType): String =
    st.asJson.asString.getOrElse(st.toString)

  private def nodeKindToString(nk: NodeKind): String =
    nk.asJson.asString.getOrElse(nk.toString)
}
