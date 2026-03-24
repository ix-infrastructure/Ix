package ix.memory.db

import java.time.Instant
import java.util.UUID

import scala.collection.mutable

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
  private val CurrentRevisionKey = "current"
  private val SourceGraphRevisionKey = "source-graph"
  private val SourceGraphIgnoredKinds: Set[NodeKind] = Set(
    NodeKind.Module,
    NodeKind.Config,
    NodeKind.ConfigEntry,
    NodeKind.Doc,
    NodeKind.Decision,
    NodeKind.Intent,
    NodeKind.Bug,
    NodeKind.Plan,
    NodeKind.Task,
    NodeKind.Goal,
    NodeKind.Region
  )
  private val SourceGraphPredicates = Set("CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS")

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

  private def doCommit(patch: GraphPatch, txId: String): IO[CommitResult] = {
    val entityIdsForClaims = patch.ops.collect {
      case PatchOp.AssertClaim(eid, _, _, _, _) => eid.value.toString
    }.toSet

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
          val advanceSourceGraphRev = shouldAdvanceSourceGraphRev(patch)
          for {
            // Step 4b: Pre-load active claims for all entities in this patch (one query)
            //           Eliminates per-claim hasIdenticalActiveClaim DB round-trips
            claimCache <- loadActiveClaimsCache(entityIdsForClaims, txId)
            // Step 5: Execute each op
            _ <- patch.ops.traverse_(op => executeOp(op, patch, newRev, txId, claimCache))
            // Step 5b: Retire absent claims — single batch query instead of one per entity
            _ <- retireAbsentClaimsBatch(patch, newRev, txId)
            // Step 6: Store patch
            _ <- storePatch(patch, newRev, txId)
            // Step 7: Store idempotency key
            _ <- storeIdempotencyKey(patch.patchId, newRev, txId)
            // Step 8: Update revision
            _ <- updateRevision(newRev, txId, advanceSourceGraphRev)
            // Step 9: Commit the transaction
            _ <- client.commitTransaction(txId)
          } yield CommitResult(Rev(newRev), CommitStatus.Ok)
        }
      }
    } yield result
  }

  private def loadLatestRev(txId: String): IO[Long] =
    client.queryOne(
      """FOR r IN revisions
        |  FILTER r._key == @key
        |  RETURN r.rev""".stripMargin,
      Map("key" -> "current".asInstanceOf[AnyRef]),
      txId = Some(txId)
    ).map(_.flatMap(_.as[Long].toOption).getOrElse(0L))

  private def executeOp(op: PatchOp, patch: GraphPatch, newRev: Long, txId: String, claimCache: mutable.Set[(String, String, String)]): IO[Unit] = op match {
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

    case PatchOp.AssertClaim(entityId, field, value, confidence, inferenceVersion) =>
      val provenanceJson = buildProvenance(patch)
      val eid      = entityId.value.toString
      val valueStr = value.noSpaces
      for {
        // Step 1: Retire active claims for same (entity_id, field) with different value
        _ <- retireClaims(eid, field, value, newRev, txId)
        // Mirror retirement in the cache: remove entries for (eid, field) with different value
        _ = claimCache.filterInPlace { case (e, f, v) => !(e == eid && f == field && v != valueStr) }
        // Step 2: Check in-memory cache — avoids a DB round-trip per claim
        _ <- if (claimCache.contains((eid, field, valueStr))) IO.unit
             else {
               val claimKey = UUID.randomUUID().toString
               for {
                 _ <- client.execute(
                   """INSERT {
                     |  _key: @key,
                     |  entity_id: @entity_id,
                     |  field: @field,
                     |  value: @value,
                     |  confidence: @confidence,
                     |  status: @status,
                     |  created_rev: @created_rev,
                     |  deleted_rev: null,
                     |  provenance: @provenance,
                     |  inference_version: @inference_version
                     |} INTO claims""".stripMargin,
                   Map(
                     "key"               -> claimKey.asInstanceOf[AnyRef],
                     "entity_id"         -> eid.asInstanceOf[AnyRef],
                     "field"             -> field.asInstanceOf[AnyRef],
                     "value"             -> jsonToJava(value).asInstanceOf[AnyRef],
                     "confidence"        -> confidence.map(Double.box).orNull.asInstanceOf[AnyRef],
                     "status"            -> "active".asInstanceOf[AnyRef],
                     "created_rev"       -> Long.box(newRev).asInstanceOf[AnyRef],
                     "provenance"        -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
                     "inference_version" -> inferenceVersion.orNull.asInstanceOf[AnyRef]
                   ),
                   txId = Some(txId)
                 )
                 _ = claimCache.add((eid, field, valueStr))
               } yield ()
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
      """UPSERT { _key: @key }
        |  INSERT { _key: @key, patch_id: @patch_id, rev: @rev, data: @data }
        |  UPDATE {}
        |  IN patches""".stripMargin,
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

  private def shouldAdvanceSourceGraphRev(patch: GraphPatch): Boolean =
    patch.ops.exists {
      case PatchOp.UpsertNode(_, kind, _, _) =>
        !SourceGraphIgnoredKinds.contains(kind)
      case PatchOp.UpsertEdge(_, _, _, predicate, _) =>
        SourceGraphPredicates.contains(predicate.value)
      case PatchOp.DeleteNode(_) | PatchOp.DeleteEdge(_) =>
        patch.source.sourceType == SourceType.Code || patch.source.sourceType == SourceType.Test
      case _ =>
        false
    }

  private def updateRevision(newRev: Long, txId: String, advanceSourceGraphRev: Boolean): IO[Unit] =
    client.execute(
      """FOR key IN @keys
        |  UPSERT { _key: key }
        |  INSERT { _key: key, rev: @rev }
        |  UPDATE { rev: @rev }
        |  IN revisions""".stripMargin,
      Map(
        "keys" -> {
          val keys =
            if (advanceSourceGraphRev) Array(CurrentRevisionKey, SourceGraphRevisionKey)
            else Array(CurrentRevisionKey)
          keys.asInstanceOf[AnyRef]
        },
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

  /**
   * Pre-load all active claims for the given entity IDs in one DB query.
   * Returns a mutable set of (entityId, field, valueNoSpaces) triples used
   * as an in-memory duplicate-check cache throughout a single patch commit.
   */
  private def loadActiveClaimsCache(entityIds: Set[String], txId: String): IO[mutable.Set[(String, String, String)]] =
    if (entityIds.isEmpty) IO.pure(mutable.Set.empty)
    else {
      val eids = new java.util.ArrayList[String]()
      entityIds.foreach(eids.add)
      client.query(
        """FOR c IN claims
          |  FILTER c.entity_id IN @entityIds AND c.deleted_rev == null
          |  RETURN { entity_id: c.entity_id, field: c.field, value: c.value }""".stripMargin,
        Map("entityIds" -> eids.asInstanceOf[AnyRef]),
        txId = Some(txId)
      ).map { results =>
        val cache = mutable.Set.empty[(String, String, String)]
        results.foreach { json =>
          val parsed = for {
            eid   <- json.hcursor.get[String]("entity_id").toOption
            field <- json.hcursor.get[String]("field").toOption
            value <- json.hcursor.downField("value").focus
          } yield (eid, field, value.noSpaces)
          parsed.foreach(cache.add)
        }
        cache
      }
    }

  /**
   * After all ops execute, retire claims from the same extractor/entity that are
   * no longer emitted (the "absent claims" policy). Uses a single batch AQL query
   * across all entities instead of one query per entity.
   */
  private def retireAbsentClaimsBatch(patch: GraphPatch, newRev: Long, txId: String): IO[Unit] = {
    val assertedClaims = patch.ops.collect {
      case PatchOp.AssertClaim(entityId, field, _, _, _) => (entityId.value.toString, field)
    }

    if (assertedClaims.isEmpty) IO.unit
    else {
      val fieldsByEntity: Map[String, Set[String]] = assertedClaims
        .groupBy(_._1)
        .map { case (eid, pairs) => eid -> pairs.map(_._2).toSet }

      // Build Java list of {entity_id, fields} for AQL — one query instead of N
      val entityFieldMap = new java.util.ArrayList[java.util.Map[String, AnyRef]]()
      fieldsByEntity.foreach { case (eid, fields) =>
        val m  = new java.util.HashMap[String, AnyRef]()
        val fl = new java.util.ArrayList[String]()
        fields.foreach(fl.add)
        m.put("entity_id", eid)
        m.put("fields", fl)
        entityFieldMap.add(m)
      }

      client.execute(
        """LET fieldMap = MERGE(
          |  FOR ef IN @entityFieldMap RETURN { [ef.entity_id]: ef.fields }
          |)
          |FOR c IN claims
          |  FILTER c.entity_id IN ATTRIBUTES(fieldMap)
          |    AND c.field NOT IN fieldMap[c.entity_id]
          |    AND c.deleted_rev == null
          |    AND c.provenance.extractor == @extractor
          |  UPDATE c WITH { status: "retracted", deleted_rev: @deleted_rev } IN claims""".stripMargin,
        Map(
          "entityFieldMap" -> entityFieldMap.asInstanceOf[AnyRef],
          "extractor"      -> patch.source.extractor.asInstanceOf[AnyRef],
          "deleted_rev"    -> Long.box(newRev).asInstanceOf[AnyRef]
        ),
        txId = Some(txId)
      )
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
