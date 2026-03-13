package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._

import ix.memory.model._

/**
 * Trait for bulk write APIs, used by BulkIngestionService.
 */
trait BulkWriteApiBase {
  def commitBatch(fileBatches: Vector[FileBatch], baseRev: Long): IO[CommitResult]
  def commitBatchChunked(fileBatches: Vector[FileBatch], baseRev: Long, chunkSize: Int = 100): IO[CommitResult]
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
