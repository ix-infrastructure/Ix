package ix.memory.db

import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.traverse._
import io.circe.Json
import io.circe.syntax._
import org.typelevel.log4cats.Logger
import org.typelevel.log4cats.slf4j.Slf4jLogger

import scala.concurrent.duration._

import ix.memory.model._

/**
 * High-performance batch writer that uses ArangoDB Document API
 * instead of individual AQL queries.
 */
class BulkWriteApi(client: ArangoClient) {
  private type BulkDoc = java.util.Map[String, AnyRef]
  private val CurrentRevisionKey = "current"
  private val SourceGraphRevisionKey = "source-graph"
  private val DefaultChunkSize = 500
  private val DefaultChunkPayloadBytes = 16 * 1024 * 1024
  private val MaxNodeDocs  = 10000
  private val MaxEdgeDocs  = 20000
  private val MaxClaimDocs = 10000
  private val MaxPatchDocs = 250
  private val SlowChunkMs = 2000L
  private val debugBulkWrites = sys.env.get("IX_DEBUG").exists(v => v.nonEmpty && v != "0" && !v.equalsIgnoreCase("false"))
  private val logger: Logger[IO] = Slf4jLogger.getLoggerFromName[IO]("ix.bulk-write")

  private def withRetry[A](action: IO[A], maxAttempts: Int = 3, delay: FiniteDuration = 500.millis): IO[A] = {
    action.handleErrorWith { err =>
      if (maxAttempts <= 1) IO.raiseError(err)
      else IO.sleep(delay) *> withRetry(action, maxAttempts - 1, delay * 2)
    }
  }

  private def chunkDocs[T](docs: Seq[T], maxDocs: Int): Seq[Seq[T]] =
    docs.grouped(maxDocs).toVector

  private def insertCollectionChunked(
    collection: String,
    docs: Seq[BulkDoc],
    maxDocs: Int
  )(insert: Seq[BulkDoc] => IO[Int]): IO[Long] =
    if (docs.isEmpty) IO.pure(0L)
    else {
      val batches = chunkDocs(docs, maxDocs)
      batches.foldLeft(IO.pure(0L)) { case (accIO, batch) =>
        for {
          acc <- accIO
          ms  <- timedUnit(withRetry(insert(batch)))
          _   <- if (debugBulkWrites)
                   logger.info(s"[bulk-write] collection=$collection docs=${batch.size} insertMs=$ms")
                 else IO.unit
        } yield acc + ms
      }
    }

  def commitBatch(
    fileBatches: Vector[FileBatch],
    baseRev: Long,
    skipTombstone: Boolean = false
  ): IO[CommitResult] = {
    val newRev = baseRev + 1L

    for {
      // Build all document maps in a single IO.blocking pass — one traversal instead of four.
      docsAndBuildMs <- timed {
        IO.blocking {
        val nodesBuf   = Vector.newBuilder[java.util.Map[String, AnyRef]]
        val edgesBuf   = Vector.newBuilder[java.util.Map[String, AnyRef]]
        val claimsBuf  = Vector.newBuilder[java.util.Map[String, AnyRef]]
        val patchesBuf = Vector.newBuilder[java.util.Map[String, AnyRef]]
        fileBatches.foreach { fb =>
          nodesBuf   ++= fb.nodeDocuments(newRev)
          edgesBuf   ++= fb.edgeDocuments(newRev)
          claimsBuf  ++= fb.claimDocuments(newRev)
          patchesBuf  += fb.patchDocument(newRev)
        }
        (nodesBuf.result(), edgesBuf.result(), claimsBuf.result(), patchesBuf.result())
        }
      }
      (docs, buildDocsMs) = docsAndBuildMs
      (allNodes, allEdges, allClaims, allPatches) = docs
      logicalIds = allNodes.flatMap(doc => Option(doc.get("logical_id")).map(_.toString))
      chunkSummary = s"files=${fileBatches.size} nodes=${allNodes.size} edges=${allEdges.size} claims=${allClaims.size} patches=${allPatches.size}"
      // Skip tombstone/retire on first ingest — DB is empty, no existing docs to update.
      tombstoneAndRetireMs <-
        if (skipTombstone || baseRev == 0) IO.pure((0L, 0L))
        else timedUnit(tombstoneExistingNodes(logicalIds, newRev))
               .both(timedUnit(retireOldClaims(fileBatches, newRev)))
      (tombstoneMs: Long, retireClaimsMs: Long) = tombstoneAndRetireMs
      // Run all four collection inserts concurrently — they write to independent collections
      // with no referential-integrity enforcement between them. Wall time drops from the
      // sum of all four to the max of any one (typically nodes or edges).
      allInsertMs <- insertCollectionChunked("nodes", allNodes, MaxNodeDocs)(docs => client.bulkInsert("nodes", docs))
                       .both(insertCollectionChunked("edges", allEdges, MaxEdgeDocs)(docs => client.bulkInsertEdges("edges", docs)))
                       .both(insertCollectionChunked("claims", allClaims, MaxClaimDocs)(docs => client.bulkInsert("claims", docs)))
                       .both(insertCollectionChunked("patches", allPatches, MaxPatchDocs)(docs => client.bulkInsert("patches", docs)))
                       .map { case (((n, e), c), p) => (n, e, c, p) }
      (insertNodesMs, insertEdgesMs, insertClaimsMs, insertPatchesMs) = allInsertMs
      updateRevMs    <- timedUnit(updateRevision(newRev))
      totalMs = buildDocsMs + tombstoneMs + retireClaimsMs + insertNodesMs + insertEdgesMs + insertClaimsMs + insertPatchesMs + updateRevMs
      _ <- logChunkTiming(
        s"rev=$newRev $chunkSummary",
        totalMs,
        List(
          "buildDocs" -> buildDocsMs,
          "tombstoneNodes" -> tombstoneMs,
          "retireClaims" -> retireClaimsMs,
          "insertNodes" -> insertNodesMs,
          "insertEdges" -> insertEdgesMs,
          "insertClaims" -> insertClaimsMs,
          "insertPatches" -> insertPatchesMs,
          "updateRevision" -> updateRevMs,
        )
      )
    } yield CommitResult(Rev(newRev), CommitStatus.Ok)
  }

  private def tombstoneExistingNodes(logicalIds: Vector[String], newRev: Long): IO[Unit] = {
    if (logicalIds.isEmpty) IO.unit
    else {
      val idList = new java.util.ArrayList[String](logicalIds.size)
      logicalIds.distinct.foreach(idList.add)
      client.execute(
        """FOR n IN nodes
          |  FILTER n.logical_id IN @ids
          |    AND n.deleted_rev == null
          |  UPDATE n WITH { deleted_rev: @rev, updated_at: @now } IN nodes""".stripMargin,
        Map(
          "ids" -> idList.asInstanceOf[AnyRef],
          "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
          "now" -> Instant.now().toString.asInstanceOf[AnyRef]
        )
      )
    }
  }

  private def retireOldClaimsByEntityIds(entityIds: Seq[String], newRev: Long): IO[Unit] =
    if (entityIds.isEmpty) IO.unit
    else {
      val idList = new java.util.ArrayList[String](entityIds.size)
      entityIds.foreach(idList.add)
      client.execute(
        """FOR c IN claims
          |  FILTER c.entity_id IN @ids
          |    AND c.deleted_rev == null
          |  UPDATE c WITH { status: "retracted", deleted_rev: @rev } IN claims""".stripMargin,
        Map(
          "ids" -> idList.asInstanceOf[AnyRef],
          "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )
    }

  private def retireOldClaims(fileBatches: Vector[FileBatch], newRev: Long): IO[Unit] =
    retireOldClaimsByEntityIds(
      fileBatches.flatMap(_.patch.ops.collect {
        case PatchOp.UpsertNode(id, _, _, _) => id.value.toString
      }).distinct,
      newRev
    )

  /**
   * Commit file batches in chunks. Each chunk gets its own revision.
   * If a chunk fails, prior chunks are preserved (partial progress).
   *
   * When multiple chunks exist and baseRev > 0 (incremental update), tombstone+retire
   * runs once upfront for all files in parallel rather than once per chunk sequentially.
   * This reduces 2*N AQL UPDATE scans to 2 — e.g. 160 → 2 for Kubernetes.
   */
  def commitBatchChunked(
    fileBatches: Vector[FileBatch],
    baseRev: Long,
    chunkSize: Int = DefaultChunkSize,
    maxPayloadBytes: Int = DefaultChunkPayloadBytes
  ): IO[CommitResult] = {
    if (fileBatches.isEmpty)
      return IO.pure(CommitResult(Rev(baseRev), CommitStatus.Ok))

    val chunks = chunkForCommit(fileBatches, chunkSize, maxPayloadBytes)
    val multiChunk = chunks.size > 1 && baseRev > 0

    // Pre-tombstone: collect all entity IDs upfront and retire/tombstone in one parallel pass.
    // Uses baseRev+1 as the tombstone rev, which is the same rev chunk 1 will use for its inserts.
    val preTombstoneIO: IO[Unit] =
      if (!multiChunk) IO.unit
      else {
        val allIds = fileBatches.flatMap(_.patch.ops.collect {
          case PatchOp.UpsertNode(id, _, _, _) => id.value.toString
        }).distinct
        val preTombRev = baseRev + 1L
        timedUnit(tombstoneExistingNodes(allIds.toVector, preTombRev))
          .both(timedUnit(retireOldClaimsByEntityIds(allIds, preTombRev)))
          .flatMap { case (tombMs, retireMs) =>
            if (debugBulkWrites)
              logger.info(s"[bulk-write] pre-tombstone files=${fileBatches.size} tombstoneMs=$tombMs retireMs=$retireMs")
            else IO.unit
          }
      }

    for {
      _ <- preTombstoneIO
      finalRev <- chunks.foldLeft(IO.pure(baseRev)) { case (revIO, chunk) =>
        revIO.flatMap { currentRev =>
          commitBatch(chunk, currentRev, skipTombstone = multiChunk).map(_.newRev.value)
        }
      }
    } yield CommitResult(Rev(finalRev), CommitStatus.Ok)
  }

  private def updateRevision(newRev: Long): IO[Unit] = {
    // Use Document API (replace mode) instead of AQL UPSERT.
    // AQL UPSERT produces write-write conflicts when multiple concurrent HTTP
    // requests all try to update the same "current" revision key simultaneously.
    // The Document API replace is atomic at the document level — no conflict possible.
    val doc1 = new java.util.HashMap[String, AnyRef]()
    doc1.put("_key", CurrentRevisionKey)
    doc1.put("rev", Long.box(newRev))
    val doc2 = new java.util.HashMap[String, AnyRef]()
    doc2.put("_key", SourceGraphRevisionKey)
    doc2.put("rev", Long.box(newRev))
    client.bulkInsert("revisions", Seq(doc1, doc2)).void
  }

  private def chunkForCommit(
    fileBatches: Vector[FileBatch],
    maxFiles: Int,
    maxPayloadBytes: Int
  ): Vector[Vector[FileBatch]] = {
    val chunks = Vector.newBuilder[Vector[FileBatch]]
    var current = Vector.empty[FileBatch]
    var currentBytes = 0

    fileBatches.foreach { batch =>
      val batchBytes = batch.estimatedPayloadBytes
      val exceedsPayload = current.nonEmpty && currentBytes + batchBytes > maxPayloadBytes
      val exceedsCount = current.size >= maxFiles
      if (exceedsPayload || exceedsCount) {
        chunks += current
        current = Vector.empty
        currentBytes = 0
      }
      current = current :+ batch
      currentBytes += batchBytes
    }

    if (current.nonEmpty) {
      chunks += current
    }

    chunks.result()
  }

  private def timed[A](ioa: IO[A]): IO[(A, Long)] =
    for {
      start <- IO.monotonic
      result <- ioa
      end <- IO.monotonic
    } yield (result, (end - start).toMillis)

  private def timedUnit[A](ioa: IO[A]): IO[Long] =
    timed(ioa).map(_._2)

  private def logChunkTiming(summary: String, totalMs: Long, stages: List[(String, Long)]): IO[Unit] = {
    val shouldLog = debugBulkWrites || totalMs >= SlowChunkMs
    if (!shouldLog) IO.unit
    else {
      val stageSummary = stages.map { case (name, ms) => s"$name=${ms}ms" }.mkString(" ")
      logger.info(s"$summary total=${totalMs}ms $stageSummary")
    }
  }
}

/**
 * Pre-computed batch of documents for a single file,
 * ready to be merged with other files and bulk-inserted.
 */
case class FileBatch(
  filePath: String,
  sourceHash: Option[String],
  patch: GraphPatch,
  provenance: java.util.Map[String, AnyRef]
) {
  // Direct Circe-to-Java conversion — no string serialization round-trip.
  private def jsonToJava(json: Json): AnyRef = json.fold(
    jsonNull    = null.asInstanceOf[AnyRef],
    jsonBoolean = b => java.lang.Boolean.valueOf(b),
    jsonNumber  = n => java.lang.Double.valueOf(n.toDouble),
    jsonString  = s => s,
    jsonArray   = arr => {
      val list = new java.util.ArrayList[AnyRef](arr.size)
      arr.foreach(j => list.add(jsonToJava(j)))
      list
    },
    jsonObject  = obj => {
      val map = new java.util.LinkedHashMap[String, AnyRef](obj.size)
      obj.toMap.foreach { case (k, v) => map.put(k, jsonToJava(v)) }
      map
    }
  )

  private def attrsToJavaMap(attrs: Map[String, Json]): java.util.Map[String, AnyRef] = {
    val result = new java.util.HashMap[String, AnyRef](attrs.size)
    attrs.foreach { case (k, v) => result.put(k, jsonToJava(v)) }
    result
  }

  private def nodeKindToString(nk: NodeKind): String =
    nk.asJson.asString.getOrElse(nk.toString)

  lazy val estimatedPayloadBytes: Int =
    patch.asJson.noSpaces.getBytes(StandardCharsets.UTF_8).length + 1024

  def nodeDocuments(rev: Long): Vector[java.util.Map[String, AnyRef]] = {
    val now = Instant.now().toString
    patch.ops.collect { case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val logicalId = id.value.toString
      val doc = new java.util.HashMap[String, AnyRef]()
      doc.put("_key", s"${logicalId}_${rev}")
      doc.put("logical_id", logicalId)
      doc.put("id", logicalId)
      doc.put("kind", nodeKindToString(kind))
      doc.put("name", name)
      doc.put("attrs", attrsToJavaMap(attrs))
      doc.put("provenance", provenance)
      doc.put("created_rev", Long.box(rev))
      doc.put("deleted_rev", null)
      doc.put("created_at", now)
      doc.put("updated_at", now)
      doc: java.util.Map[String, AnyRef]
    }
  }

  def edgeDocuments(rev: Long): Vector[java.util.Map[String, AnyRef]] = {
    val now = Instant.now().toString
    patch.ops.collect { case PatchOp.UpsertEdge(id, src, dst, predicate, attrs) =>
      val doc = new java.util.HashMap[String, AnyRef]()
      doc.put("_key", id.value.toString)
      doc.put("_from", s"nodes/${src.value}")
      doc.put("_to", s"nodes/${dst.value}")
      doc.put("id", id.value.toString)
      doc.put("src", src.value.toString)
      doc.put("dst", dst.value.toString)
      doc.put("predicate", predicate.value)
      doc.put("attrs", attrsToJavaMap(attrs))
      doc.put("created_rev", Long.box(rev))
      doc.put("deleted_rev", null)
      doc.put("provenance", provenance)
      doc.put("created_at", now)
      doc.put("updated_at", now)
      doc: java.util.Map[String, AnyRef]
    }
  }

  def claimDocuments(rev: Long): Vector[java.util.Map[String, AnyRef]] =
    patch.ops.collect { case PatchOp.AssertClaim(entityId, field, value, confidence, inferenceVersion) =>
      val doc = new java.util.HashMap[String, AnyRef]()
      doc.put("_key", UUID.randomUUID().toString)
      doc.put("entity_id", entityId.value.toString)
      doc.put("field", field)
      doc.put("value", jsonToJava(value))
      doc.put("confidence", confidence.map(java.lang.Double.valueOf).orNull)
      doc.put("status", "active")
      doc.put("created_rev", Long.box(rev))
      doc.put("deleted_rev", null)
      doc.put("provenance", provenance)
      doc.put("inference_version", inferenceVersion.orNull)
      doc: java.util.Map[String, AnyRef]
    }

  def patchDocument(rev: Long): java.util.Map[String, AnyRef] = {
    val source = new java.util.HashMap[String, AnyRef]()
    source.put("uri", patch.source.uri)
    source.put("sourceHash", patch.source.sourceHash.orNull)
    source.put("extractor", patch.source.extractor)
    source.put("sourceType", patch.source.sourceType.asJson.asString.getOrElse(patch.source.sourceType.toString))

    val replaces = new java.util.ArrayList[String](patch.replaces.size)
    patch.replaces.foreach(id => replaces.add(id.value.toString))

    val entityIds = new java.util.LinkedHashSet[String]()
    var nodeOpCount = 0
    var edgeOpCount = 0
    var claimOpCount = 0
    patch.ops.foreach {
      case PatchOp.UpsertNode(id, _, _, _) =>
        nodeOpCount += 1
        entityIds.add(id.value.toString)
      case PatchOp.DeleteNode(id) =>
        nodeOpCount += 1
        entityIds.add(id.value.toString)
      case PatchOp.UpsertEdge(id, _, _, _, _) =>
        edgeOpCount += 1
        entityIds.add(id.value.toString)
      case PatchOp.DeleteEdge(id) =>
        edgeOpCount += 1
        entityIds.add(id.value.toString)
      case PatchOp.AssertClaim(entityId, _, _, _, _) =>
        claimOpCount += 1
        entityIds.add(entityId.value.toString)
      case PatchOp.RetractClaim(claimId) =>
        claimOpCount += 1
        entityIds.add(claimId.value.toString)
    }

    val entityIdList = new java.util.ArrayList[String](entityIds.size)
    val entityIdIter = entityIds.iterator()
    while (entityIdIter.hasNext) {
      entityIdList.add(entityIdIter.next())
    }

    val data = new java.util.HashMap[String, AnyRef]()
    data.put("patchId", patch.patchId.value.toString)
    data.put("actor", patch.actor)
    data.put("timestamp", patch.timestamp.toString)
    data.put("source", source)
    data.put("baseRev", Long.box(patch.baseRev.value))
    data.put("replaces", replaces)
    data.put("intent", patch.intent.orNull)
    data.put("entityIds", entityIdList)
    data.put("opCount", Int.box(patch.ops.size))
    data.put("nodeOpCount", Int.box(nodeOpCount))
    data.put("edgeOpCount", Int.box(edgeOpCount))
    data.put("claimOpCount", Int.box(claimOpCount))

    val doc = new java.util.HashMap[String, AnyRef]()
    doc.put("_key", patch.patchId.value.toString)
    doc.put("patch_id", patch.patchId.value.toString)
    doc.put("rev", Long.box(rev))
    // Bulk ingest only needs patch metadata plus touched-entity IDs for provenance
    // and source-hash lookups. Storing full ops here duplicates the graph payload
    // and significantly inflates Kubernetes save latency.
    doc.put("data", data)
    doc: java.util.Map[String, AnyRef]
  }
}
