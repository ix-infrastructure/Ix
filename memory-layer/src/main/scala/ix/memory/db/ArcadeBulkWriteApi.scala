package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.implicits._
import io.circe.Json
import io.circe.syntax._

import ix.memory.model._

/**
 * High-throughput batch writer for ArcadeDB.
 *
 * Since ArcadeDB is embedded (no network overhead), this implementation
 * processes each FileBatch using the same logic as ArcadeGraphWriteApi
 * rather than a custom bulk document API.
 */
class ArcadeBulkWriteApi(client: ArcadeClient) extends BulkWriteApiBase {

  def commitBatch(
    fileBatches: Vector[FileBatch],
    baseRev: Long
  ): IO[CommitResult] = {
    val newRev = baseRev + 1L

    for {
      // Tombstone existing nodes for all batches
      _ <- tombstoneExistingNodes(fileBatches, newRev)
      // Retire old claims for entities being re-asserted
      _ <- retireOldClaims(fileBatches, newRev)
      // Insert all new nodes
      _ <- fileBatches.traverse_(insertNodes(_, newRev))
      // Insert all new edges
      _ <- fileBatches.traverse_(insertEdges(_, newRev))
      // Insert all new claims
      _ <- fileBatches.traverse_(insertClaims(_, newRev))
      // Store patch documents
      _ <- fileBatches.traverse_(storePatch(_, newRev))
      // Update revision
      _ <- updateRevision(newRev)
    } yield CommitResult(Rev(newRev), CommitStatus.Ok)
  }

  def commitBatchChunked(
    fileBatches: Vector[FileBatch],
    baseRev: Long,
    chunkSize: Int = 100
  ): IO[CommitResult] = {
    if (fileBatches.isEmpty)
      return IO.pure(CommitResult(Rev(baseRev), CommitStatus.Ok))

    val chunks = fileBatches.grouped(chunkSize).toVector

    chunks.foldLeft(IO.pure(baseRev)) { case (revIO, chunk) =>
      revIO.flatMap { currentRev =>
        commitBatch(chunk, currentRev).map(_.newRev.value)
      }
    }.map(finalRev => CommitResult(Rev(finalRev), CommitStatus.Ok))
  }

  // ── Private helpers ───────────────────────────────────────────────

  private def tombstoneExistingNodes(fileBatches: Vector[FileBatch], newRev: Long): IO[Unit] = {
    val logicalIds = fileBatches.flatMap { batch =>
      batch.patch.ops.collect { case PatchOp.UpsertNode(id, _, _, _) => id.value.toString }
    }.distinct

    if (logicalIds.isEmpty) IO.unit
    else {
      val now = Instant.now().toString
      logicalIds.traverse_ { logicalId =>
        client.command(
          "UPDATE ix_nodes SET deleted_rev = :rev, updated_at = :now WHERE logical_id = :logicalId AND deleted_rev IS NULL",
          Map(
            "rev"       -> Long.box(newRev).asInstanceOf[AnyRef],
            "now"       -> now.asInstanceOf[AnyRef],
            "logicalId" -> logicalId.asInstanceOf[AnyRef]
          )
        )
      }
    }
  }

  private def retireOldClaims(fileBatches: Vector[FileBatch], newRev: Long): IO[Unit] = {
    val entityIds = fileBatches.flatMap(_.patch.ops.collect {
      case PatchOp.UpsertNode(id, _, _, _) => id.value.toString
    }).distinct

    if (entityIds.isEmpty) IO.unit
    else {
      entityIds.traverse_ { entityId =>
        client.command(
          "UPDATE ix_claims SET status = 'retracted', deleted_rev = :rev WHERE entity_id = :eid AND deleted_rev IS NULL",
          Map(
            "eid" -> entityId.asInstanceOf[AnyRef],
            "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
          )
        )
      }
    }
  }

  private def insertNodes(batch: FileBatch, newRev: Long): IO[Unit] = {
    val now = Instant.now().toString
    batch.patch.ops.collect { case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val logicalId = id.value.toString
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      client.command(
        """INSERT INTO ix_nodes SET logical_id = :logicalId, kind = :kind, name = :name, attrs = :attrs, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL, created_at = :now, updated_at = :now""",
        Map(
          "logicalId"   -> logicalId.asInstanceOf[AnyRef],
          "kind"        -> nodeKindToString(kind).asInstanceOf[AnyRef],
          "name"        -> name.asInstanceOf[AnyRef],
          "attrs"       -> attrsJson.asInstanceOf[AnyRef],
          "source_uri"  -> batch.patch.source.uri.asInstanceOf[AnyRef],
          "source_hash" -> batch.patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
          "extractor"   -> batch.patch.source.extractor.asInstanceOf[AnyRef],
          "source_type" -> sourceTypeToString(batch.patch.source.sourceType).asInstanceOf[AnyRef],
          "rev"         -> Long.box(newRev).asInstanceOf[AnyRef],
          "now"         -> now.asInstanceOf[AnyRef]
        )
      )
    }.traverse_(identity)
  }

  private def insertEdges(batch: FileBatch, newRev: Long): IO[Unit] = {
    val now = Instant.now().toString
    batch.patch.ops.collect { case PatchOp.UpsertEdge(id, src, dst, predicate, attrs) =>
      val edgeId = id.value.toString
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      client.command(
        """INSERT INTO ix_edges SET edge_id = :edgeId, src = :src, dst = :dst, predicate = :pred, attrs = :attrs, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL, created_at = :now, updated_at = :now""",
        Map(
          "edgeId"      -> edgeId.asInstanceOf[AnyRef],
          "src"         -> src.value.toString.asInstanceOf[AnyRef],
          "dst"         -> dst.value.toString.asInstanceOf[AnyRef],
          "pred"        -> predicate.value.asInstanceOf[AnyRef],
          "attrs"       -> attrsJson.asInstanceOf[AnyRef],
          "source_uri"  -> batch.patch.source.uri.asInstanceOf[AnyRef],
          "source_hash" -> batch.patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
          "extractor"   -> batch.patch.source.extractor.asInstanceOf[AnyRef],
          "source_type" -> sourceTypeToString(batch.patch.source.sourceType).asInstanceOf[AnyRef],
          "rev"         -> Long.box(newRev).asInstanceOf[AnyRef],
          "now"         -> now.asInstanceOf[AnyRef]
        )
      )
    }.traverse_(identity)
  }

  private def insertClaims(batch: FileBatch, newRev: Long): IO[Unit] = {
    batch.patch.ops.collect { case PatchOp.AssertClaim(entityId, field, value, confidence) =>
      val valueStr = value.noSpaces
      val confValue = confidence.map(Double.box).orNull
      client.command(
        """INSERT INTO ix_claims SET entity_id = :eid, field = :field, value = :val, status = 'active', confidence = :conf, source_uri = :source_uri, source_hash = :source_hash, extractor = :extractor, source_type = :source_type, created_rev = :rev, deleted_rev = NULL""",
        Map(
          "eid"         -> entityId.value.toString.asInstanceOf[AnyRef],
          "field"       -> field.asInstanceOf[AnyRef],
          "val"         -> valueStr.asInstanceOf[AnyRef],
          "conf"        -> confValue.asInstanceOf[AnyRef],
          "source_uri"  -> batch.patch.source.uri.asInstanceOf[AnyRef],
          "source_hash" -> batch.patch.source.sourceHash.orNull.asInstanceOf[AnyRef],
          "extractor"   -> batch.patch.source.extractor.asInstanceOf[AnyRef],
          "source_type" -> sourceTypeToString(batch.patch.source.sourceType).asInstanceOf[AnyRef],
          "rev"         -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )
    }.traverse_(identity)
  }

  private def storePatch(batch: FileBatch, newRev: Long): IO[Unit] = {
    val patchJson = batch.patch.asJson.noSpaces
    client.command(
      """INSERT INTO ix_patches SET patch_id = :patch_id, rev = :rev, data = :data""",
      Map(
        "patch_id" -> batch.patch.patchId.value.toString.asInstanceOf[AnyRef],
        "rev"      -> Long.box(newRev).asInstanceOf[AnyRef],
        "data"     -> patchJson.asInstanceOf[AnyRef]
      )
    )
  }

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

  private def sourceTypeToString(st: SourceType): String =
    st.asJson.asString.getOrElse(st.toString)

  private def nodeKindToString(nk: NodeKind): String =
    nk.asJson.asString.getOrElse(nk.toString)
}
