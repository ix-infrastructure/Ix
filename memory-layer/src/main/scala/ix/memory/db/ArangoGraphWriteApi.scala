package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.traverse._
import cats.syntax.foldable._
import cats.instances.vector._
import io.circe.syntax._
import io.circe.Json

import ix.memory.model._

class ArangoGraphWriteApi(client: ArangoClient) extends GraphWriteApi {

  // I1 fix: single ObjectMapper instance shared across all calls
  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

  // ── Collections involved in a commit transaction ──────────────────

  private val ReadCollections  = Seq("revisions", "idempotency_keys")
  private val WriteCollections = Seq("nodes", "edges", "claims", "patches", "revisions", "idempotency_keys")

  // ── Public entry point ────────────────────────────────────────────

  override def commitPatch(patch: GraphPatch): IO[CommitResult] =
    client.beginTransaction(ReadCollections, WriteCollections).flatMap { txId =>
      val commit = for {
        // Step 1: Check idempotency inside the transaction
        idempotent <- checkIdempotency(patch.patchId, txId)
        result     <- idempotent match {
          case Some(storedRev) =>
            // Already applied — commit the (read-only) transaction and return
            client.commitTransaction(txId) *>
              IO.pure(CommitResult(storedRev, CommitStatus.Idempotent))
          case None =>
            doCommit(patch, txId)
        }
      } yield result

      commit.handleErrorWith { err =>
        client.abortTransaction(txId) *> IO.raiseError(err)
      }
    }

  // ── Private helpers ───────────────────────────────────────────────

  private def checkIdempotency(patchId: PatchId, txId: String): IO[Option[Rev]] =
    client.queryOne(
      """FOR ik IN idempotency_keys
        |  FILTER ik.key == @key
        |  RETURN ik.rev""".stripMargin,
      Map("key" -> idempotencyKey(patchId).asInstanceOf[AnyRef]),
      txId = Some(txId)
    ).map(_.flatMap(_.as[Long].toOption).map(Rev(_)))

  private def idempotencyKey(patchId: PatchId): String =
    patchId.value.toString

  private def doCommit(patch: GraphPatch, txId: String): IO[CommitResult] =
    for {
      // Step 2: Load latest_rev (inside transaction)
      latestRev <- loadLatestRev(txId)

      // Step 3: Check baseRev (if > 0, must match latest)
      result <- {
        if (patch.baseRev.value > 0L && patch.baseRev.value != latestRev) {
          // Mismatch — commit the read-only transaction cleanly, then return
          client.commitTransaction(txId) *>
            IO.pure(CommitResult(Rev(latestRev), CommitStatus.BaseRevMismatch))
        } else {
          val newRev = latestRev + 1L
          for {
            // Step 5: Execute each op
            _ <- patch.ops.traverse_(op => executeOp(op, patch, newRev, txId))
            // Step 5b: Retire absent claims (claims from same extractor/entity no longer emitted)
            _ <- retireAbsentClaims(patch, newRev, txId)
            // Step 6: Store patch
            _ <- storePatch(patch, newRev, txId)
            // Step 7: Store idempotency key
            _ <- storeIdempotencyKey(patch.patchId, newRev, txId)
            // Step 8: Update revision
            _ <- updateRevision(newRev, txId)
            // Step 9: Commit the transaction
            _ <- client.commitTransaction(txId)
          } yield CommitResult(Rev(newRev), CommitStatus.Ok)
        }
      }
    } yield result

  private def loadLatestRev(txId: String): IO[Long] =
    client.queryOne(
      """FOR r IN revisions
        |  FILTER r._key == @key
        |  RETURN r.rev""".stripMargin,
      Map("key" -> "current".asInstanceOf[AnyRef]),
      txId = Some(txId)
    ).map(_.flatMap(_.as[Long].toOption).getOrElse(0L))

  private def executeOp(op: PatchOp, patch: GraphPatch, newRev: Long, txId: String): IO[Unit] = op match {
    case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val logicalId = id.value.toString
      val now = Instant.now().toString
      val provenanceJson = buildProvenance(patch)
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces

      // Check if a live (non-tombstoned) row exists for this logical_id
      val checkAql = """
        FOR n IN nodes
          FILTER n.logical_id == @logicalId
            AND n.deleted_rev == null
          RETURN n
      """
      for {
        existing <- client.queryOne(checkAql,
          Map("logicalId" -> logicalId.asInstanceOf[AnyRef]),
          txId = Some(txId))
        _ <- existing match {
          case Some(existingJson) =>
            // Node exists — check if attrs actually changed
            val existingAttrsStr = existingJson.hcursor.downField("attrs").focus
              .map(_.noSpaces).getOrElse("{}")
            if (existingAttrsStr == attrsJson) {
              // Same attrs — idempotent no-op
              IO.unit
            } else {
              // Different attrs — tombstone old row + create new versioned row
              val existingKey = existingJson.hcursor.get[String]("_key")
                .getOrElse(logicalId)
              val tombstoneAql = """
                UPDATE { _key: @key } WITH { deleted_rev: @rev, updated_at: @now } IN nodes
                  OPTIONS { waitForSync: true }
              """
              val newKey = s"${logicalId}_${newRev}"
              val upsertAql = """
                UPSERT { _key: @key }
                INSERT {
                  _key: @key, logical_id: @logicalId, id: @id, kind: @kind, name: @name,
                  attrs: @attrs, provenance: @provenance,
                  created_rev: @rev, deleted_rev: null,
                  created_at: @now, updated_at: @now
                }
                UPDATE {
                  logical_id: @logicalId, id: @id, kind: @kind, name: @name,
                  attrs: @attrs, provenance: @provenance,
                  deleted_rev: null, updated_at: @now
                }
                IN nodes OPTIONS { waitForSync: true }
              """
              for {
                _ <- client.execute(tombstoneAql, Map(
                  "key" -> existingKey.asInstanceOf[AnyRef],
                  "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
                  "now" -> now.asInstanceOf[AnyRef]
                ), txId = Some(txId))
                _ <- client.execute(upsertAql, Map(
                  "key"        -> newKey.asInstanceOf[AnyRef],
                  "logicalId"  -> logicalId.asInstanceOf[AnyRef],
                  "id"         -> logicalId.asInstanceOf[AnyRef],
                  "kind"       -> nodeKindToString(kind).asInstanceOf[AnyRef],
                  "name"       -> name.asInstanceOf[AnyRef],
                  "attrs"      -> parseToJavaMap(attrsJson).asInstanceOf[AnyRef],
                  "provenance" -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
                  "rev"        -> Long.box(newRev).asInstanceOf[AnyRef],
                  "now"        -> now.asInstanceOf[AnyRef]
                ), txId = Some(txId))
              } yield ()
            }

          case None =>
            // New node — create first row with versioned key
            val newKey = s"${logicalId}_${newRev}"
            val upsertAql = """
              UPSERT { _key: @key }
              INSERT {
                _key: @key, logical_id: @logicalId, id: @id, kind: @kind, name: @name,
                attrs: @attrs, provenance: @provenance,
                created_rev: @rev, deleted_rev: null,
                created_at: @now, updated_at: @now
              }
              UPDATE {
                logical_id: @logicalId, id: @id, kind: @kind, name: @name,
                attrs: @attrs, provenance: @provenance,
                deleted_rev: null, updated_at: @now
              }
              IN nodes OPTIONS { waitForSync: true }
            """
            client.execute(upsertAql, Map(
              "key"        -> newKey.asInstanceOf[AnyRef],
              "logicalId"  -> logicalId.asInstanceOf[AnyRef],
              "id"         -> logicalId.asInstanceOf[AnyRef],
              "kind"       -> nodeKindToString(kind).asInstanceOf[AnyRef],
              "name"       -> name.asInstanceOf[AnyRef],
              "attrs"      -> parseToJavaMap(attrsJson).asInstanceOf[AnyRef],
              "provenance" -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
              "rev"        -> Long.box(newRev).asInstanceOf[AnyRef],
              "now"        -> now.asInstanceOf[AnyRef]
            ), txId = Some(txId))
        }
      } yield ()

    case PatchOp.UpsertEdge(id, src, dst, predicate, attrs) =>
      val now = Instant.now().toString
      val provenanceJson = buildProvenance(patch)
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      client.execute(
        """UPSERT { _key: @key }
          |  INSERT {
          |    _key: @key,
          |    _from: @from,
          |    _to: @to,
          |    id: @id,
          |    src: @src,
          |    dst: @dst,
          |    predicate: @predicate,
          |    attrs: @attrs,
          |    created_rev: @created_rev,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    created_at: @now,
          |    updated_at: @now
          |  }
          |  UPDATE {
          |    _from: @from,
          |    _to: @to,
          |    src: @src,
          |    dst: @dst,
          |    predicate: @predicate,
          |    attrs: @attrs,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    updated_at: @now
          |  }
          |  IN edges""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "id"          -> id.value.toString.asInstanceOf[AnyRef],
          "from"        -> s"nodes/${src.value}".asInstanceOf[AnyRef],
          "to"          -> s"nodes/${dst.value}".asInstanceOf[AnyRef],
          "src"         -> src.value.toString.asInstanceOf[AnyRef],
          "dst"         -> dst.value.toString.asInstanceOf[AnyRef],
          "predicate"   -> predicate.value.asInstanceOf[AnyRef],
          "attrs"       -> parseToJavaMap(attrsJson).asInstanceOf[AnyRef],
          "created_rev" -> Long.box(newRev).asInstanceOf[AnyRef],
          "provenance"  -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
          "now"         -> now.asInstanceOf[AnyRef]
        ),
        txId = Some(txId)
      )

    case PatchOp.DeleteNode(id) =>
      client.execute(
        """FOR n IN nodes
          |  FILTER n.logical_id == @logicalId AND n.deleted_rev == null
          |  UPDATE n WITH { deleted_rev: @deleted_rev } IN nodes""".stripMargin,
        Map(
          "logicalId"   -> id.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        ),
        txId = Some(txId)
      )

    case PatchOp.DeleteEdge(id) =>
      client.execute(
        """FOR e IN edges
          |  FILTER e._key == @key
          |  UPDATE e WITH { deleted_rev: @deleted_rev } IN edges""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        ),
        txId = Some(txId)
      )

    case PatchOp.AssertClaim(entityId, field, value, confidence) =>
      val provenanceJson = buildProvenance(patch)
      for {
        // Step 1: Retire active claims for same (entity_id, field) with different value
        _ <- retireClaims(entityId.value.toString, field, value, newRev, txId)
        // Step 2: Check if identical active claim already exists
        hasDuplicate <- hasIdenticalActiveClaim(entityId.value.toString, field, value, txId)
        // Step 3: Only insert if no duplicate
        _ <- if (hasDuplicate) IO.unit
             else {
               val claimKey = UUID.randomUUID().toString
               client.execute(
                 """INSERT {
                   |  _key: @key,
                   |  entity_id: @entity_id,
                   |  field: @field,
                   |  value: @value,
                   |  confidence: @confidence,
                   |  status: @status,
                   |  created_rev: @created_rev,
                   |  deleted_rev: null,
                   |  provenance: @provenance
                   |} INTO claims""".stripMargin,
                 Map(
                   "key"         -> claimKey.asInstanceOf[AnyRef],
                   "entity_id"   -> entityId.value.toString.asInstanceOf[AnyRef],
                   "field"       -> field.asInstanceOf[AnyRef],
                   "value"       -> jsonToJava(value).asInstanceOf[AnyRef],
                   "confidence"  -> confidence.map(Double.box).orNull.asInstanceOf[AnyRef],
                   "status"      -> "active".asInstanceOf[AnyRef],
                   "created_rev" -> Long.box(newRev).asInstanceOf[AnyRef],
                   "provenance"  -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef]
                 ),
                 txId = Some(txId)
               )
             }
      } yield ()

    case PatchOp.RetractClaim(claimId) =>
      client.execute(
        """FOR c IN claims
          |  FILTER c._key == @key
          |  UPDATE c WITH { status: "retracted", deleted_rev: @deleted_rev } IN claims""".stripMargin,
        Map(
          "key"         -> claimId.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        ),
        txId = Some(txId)
      )
  }

  private def storePatch(patch: GraphPatch, newRev: Long, txId: String): IO[Unit] = {
    val patchJson = patch.asJson.noSpaces
    client.execute(
      """INSERT {
        |  _key: @key,
        |  patch_id: @patch_id,
        |  rev: @rev,
        |  data: @data
        |} INTO patches""".stripMargin,
      Map(
        "key"      -> patch.patchId.value.toString.asInstanceOf[AnyRef],
        "patch_id" -> patch.patchId.value.toString.asInstanceOf[AnyRef],
        "rev"      -> Long.box(newRev).asInstanceOf[AnyRef],
        "data"     -> parseToJavaMap(patchJson).asInstanceOf[AnyRef]
      ),
      txId = Some(txId)
    )
  }

  private def storeIdempotencyKey(patchId: PatchId, newRev: Long, txId: String): IO[Unit] =
    client.execute(
      """INSERT {
        |  key: @key,
        |  rev: @rev,
        |  created_at: DATE_NOW() / 1000
        |} INTO idempotency_keys""".stripMargin,
      Map(
        "key" -> idempotencyKey(patchId).asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      ),
      txId = Some(txId)
    )

  private def updateRevision(newRev: Long, txId: String): IO[Unit] =
    client.execute(
      """UPSERT { _key: @key }
        |  INSERT { _key: @key, rev: @rev }
        |  UPDATE { rev: @rev }
        |  IN revisions""".stripMargin,
      Map(
        "key" -> "current".asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      ),
      txId = Some(txId)
    )

  /** Retire active claims for the same (entity_id, field) that have a different value. */
  private def retireClaims(entityId: String, field: String, value: Json, newRev: Long, txId: String): IO[Unit] =
    client.execute(
      """FOR c IN claims
        |  FILTER c.entity_id == @entity_id
        |    AND c.field == @field
        |    AND c.deleted_rev == null
        |    AND c.value != @value
        |  UPDATE c WITH { status: "retracted", deleted_rev: @deleted_rev } IN claims""".stripMargin,
      Map(
        "entity_id"   -> entityId.asInstanceOf[AnyRef],
        "field"       -> field.asInstanceOf[AnyRef],
        "value"       -> jsonToJava(value).asInstanceOf[AnyRef],
        "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      ),
      txId = Some(txId)
    )

  /** Check if an identical active claim already exists (same entity, field, value). */
  private def hasIdenticalActiveClaim(entityId: String, field: String, value: Json, txId: String): IO[Boolean] =
    client.queryOne(
      """FOR c IN claims
        |  FILTER c.entity_id == @entity_id
        |    AND c.field == @field
        |    AND c.value == @value
        |    AND c.deleted_rev == null
        |  LIMIT 1
        |  RETURN 1""".stripMargin,
      Map(
        "entity_id" -> entityId.asInstanceOf[AnyRef],
        "field"     -> field.asInstanceOf[AnyRef],
        "value"     -> jsonToJava(value).asInstanceOf[AnyRef]
      ),
      txId = Some(txId)
    ).map(_.isDefined)

  /**
   * After all ops execute, retire claims from the same extractor/entity that are
   * no longer emitted (the "absent claims" policy). This handles the case where
   * a re-parsed file no longer contains a previously asserted claim.
   */
  private def retireAbsentClaims(patch: GraphPatch, newRev: Long, txId: String): IO[Unit] = {
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
        val fieldList = new java.util.ArrayList[String]()
        fields.foreach(fieldList.add)
        client.execute(
          """FOR c IN claims
            |  FILTER c.entity_id == @entity_id
            |    AND c.field NOT IN @fields
            |    AND c.deleted_rev == null
            |    AND c.provenance.extractor == @extractor
            |  UPDATE c WITH { status: "retracted", deleted_rev: @deleted_rev } IN claims""".stripMargin,
          Map(
            "entity_id"   -> entityId.asInstanceOf[AnyRef],
            "fields"      -> fieldList.asInstanceOf[AnyRef],
            "extractor"   -> extractor.asInstanceOf[AnyRef],
            "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
          ),
          txId = Some(txId)
        )
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

  // I3 fix: reuse Circe encoders instead of duplicating string conversion logic
  private def sourceTypeToString(st: SourceType): String =
    st.asJson.asString.getOrElse(st.toString)

  private def nodeKindToString(nk: NodeKind): String =
    nk.asJson.asString.getOrElse(nk.toString)

  /** Convert a JSON string into a java.util.Map for use as an ArangoDB bind variable. */
  private def parseToJavaMap(jsonStr: String): java.util.Map[String, AnyRef] =
    mapper.readValue(jsonStr, classOf[java.util.Map[String, AnyRef]])

  /** Convert a circe Json value to a Java object suitable for ArangoDB bind variables. */
  private def jsonToJava(json: Json): AnyRef =
    mapper.readValue(json.noSpaces, classOf[AnyRef])
}
