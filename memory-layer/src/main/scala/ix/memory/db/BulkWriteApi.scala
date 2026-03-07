package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.traverse._
import io.circe.Json
import io.circe.syntax._

import ix.memory.model._

/**
 * High-performance batch writer that uses ArangoDB Document API
 * instead of individual AQL queries.
 */
class BulkWriteApi(client: ArangoClient) {

  def commitBatch(
    fileBatches: Vector[FileBatch],
    baseRev: Long
  ): IO[CommitResult] = {
    val newRev = baseRev + 1L

    val allNodes   = fileBatches.flatMap(_.nodeDocuments(newRev))
    val allEdges   = fileBatches.flatMap(_.edgeDocuments(newRev))
    val allClaims  = fileBatches.flatMap(_.claimDocuments(newRev))
    val allPatches = fileBatches.map(_.patchDocument(newRev))

    // Collect all logical_ids being upserted for tombstoning
    val logicalIds = allNodes.flatMap { doc =>
      Option(doc.get("logical_id")).map(_.toString)
    }

    for {
      _ <- tombstoneExistingNodes(logicalIds, newRev)
      _ <- retireOldClaims(fileBatches, newRev)
      _ <- client.bulkInsert("nodes", allNodes)
      _ <- client.bulkInsertEdges("edges", allEdges)
      _ <- client.bulkInsert("claims", allClaims)
      _ <- client.bulkInsert("patches", allPatches)
      _ <- updateRevision(newRev)
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

  private def retireOldClaims(fileBatches: Vector[FileBatch], newRev: Long): IO[Unit] = {
    val entityIds = fileBatches.flatMap(_.patch.ops.collect {
      case PatchOp.UpsertNode(id, _, _, _) => id.value.toString
    }).distinct
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
  }

  private def updateRevision(newRev: Long): IO[Unit] =
    client.execute(
      """UPSERT { _key: @key }
        |  INSERT { _key: @key, rev: @rev }
        |  UPDATE { rev: @rev }
        |  IN revisions""".stripMargin,
      Map(
        "key" -> "current".asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      )
    )
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
  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

  private def parseToJavaMap(jsonStr: String): java.util.Map[String, AnyRef] =
    mapper.readValue(jsonStr, classOf[java.util.Map[String, AnyRef]])

  private def jsonToJava(json: Json): AnyRef =
    mapper.readValue(json.noSpaces, classOf[AnyRef])

  private def nodeKindToString(nk: NodeKind): String =
    nk.asJson.asString.getOrElse(nk.toString)

  def nodeDocuments(rev: Long): Vector[java.util.Map[String, AnyRef]] = {
    val now = Instant.now().toString
    patch.ops.collect { case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val logicalId = id.value.toString
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      val doc = new java.util.HashMap[String, AnyRef]()
      doc.put("_key", s"${logicalId}_${rev}")
      doc.put("logical_id", logicalId)
      doc.put("id", logicalId)
      doc.put("kind", nodeKindToString(kind))
      doc.put("name", name)
      doc.put("attrs", parseToJavaMap(attrsJson))
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
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      val doc = new java.util.HashMap[String, AnyRef]()
      doc.put("_key", id.value.toString)
      doc.put("_from", s"nodes/${src.value}")
      doc.put("_to", s"nodes/${dst.value}")
      doc.put("id", id.value.toString)
      doc.put("src", src.value.toString)
      doc.put("dst", dst.value.toString)
      doc.put("predicate", predicate.value)
      doc.put("attrs", parseToJavaMap(attrsJson))
      doc.put("created_rev", Long.box(rev))
      doc.put("deleted_rev", null)
      doc.put("provenance", provenance)
      doc.put("created_at", now)
      doc.put("updated_at", now)
      doc: java.util.Map[String, AnyRef]
    }
  }

  def claimDocuments(rev: Long): Vector[java.util.Map[String, AnyRef]] =
    patch.ops.collect { case PatchOp.AssertClaim(entityId, field, value, confidence) =>
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
      doc: java.util.Map[String, AnyRef]
    }

  def patchDocument(rev: Long): java.util.Map[String, AnyRef] = {
    val patchJson = patch.asJson.noSpaces
    val doc = new java.util.HashMap[String, AnyRef]()
    doc.put("_key", patch.patchId.value.toString)
    doc.put("patch_id", patch.patchId.value.toString)
    doc.put("rev", Long.box(rev))
    doc.put("data", mapper.readValue(patchJson, classOf[java.util.Map[String, AnyRef]]))
    doc: java.util.Map[String, AnyRef]
  }
}
