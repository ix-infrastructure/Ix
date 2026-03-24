package ix.memory.smell

import java.util.UUID

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._

import ix.memory.db.{ArangoClient, GraphQueryApi}

class SubsystemService(client: ArangoClient, queryApi: GraphQueryApi) {

  private val InferenceVersion = "subsystem_v1"
  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()

  // ── Public API ──────────────────────────────────────────────────────

  def scoreSubsystems(): IO[Json] =
    for {
      rows   <- queryRawData()
      scores  = rows.map(computeScore)
      rev    <- queryApi.getLatestRev
      _      <- retireOldScores()
      _      <- storeScores(scores, rev.value)
    } yield Json.obj("scores" -> scores.map(encodeScore).asJson)

  def listSubsystems(): IO[Json] =
    client.query(
      """FOR c IN claims
        |  FILTER c.field == "subsystem_health" AND c.deleted_rev == null
        |  RETURN {
        |    region_id:         c.entity_id,
        |    name:              c.value.name,
        |    level:             c.value.level,
        |    label_kind:        c.value.label_kind,
        |    file_count:        c.value.file_count,
        |    health_score:      c.value.health_score,
        |    chunk_density:     c.value.chunk_density,
        |    smell_rate:        c.value.smell_rate,
        |    smell_files:       c.value.smell_files,
        |    total_chunks:      c.value.total_chunks,
        |    confidence:        c.value.confidence,
        |    inference_version: c.value.inference_version
        |  }""".stripMargin,
      Map.empty
    ).map(scores => Json.obj("scores" -> scores.asJson))

  // ── Internal data model ─────────────────────────────────────────────

  private case class RawData(
    regionId:    String,
    name:        String,
    level:       Int,
    labelKind:   String,
    fileCount:   Int,
    totalChunks: Int,
    smellFiles:  Int,
    confidence:  Double
  )

  private case class Score(
    regionId:     String,
    name:         String,
    level:        Int,
    labelKind:    String,
    fileCount:    Int,
    healthScore:  Double,
    chunkDensity: Double,
    smellRate:    Double,
    smellFiles:   Int,
    totalChunks:  Int,
    confidence:   Double
  )

  // ── Raw data query ──────────────────────────────────────────────────

  /**
   * Single AQL query that joins regions with smell claims and CONTAINS_CHUNK
   * edge counts.  The MERGE + SUM approach avoids N+1 queries.
   */
  private def queryRawData(): IO[List[RawData]] =
    client.query(
      """LET smell_ids = (
        |  FOR c IN claims
        |    FILTER STARTS_WITH(c.field, "has_smell.") AND c.deleted_rev == null
        |    RETURN DISTINCT c.entity_id
        |)
        |LET chunk_map = MERGE(
        |  FOR e IN edges
        |    FILTER e.predicate == "CONTAINS" AND e.deleted_rev == null
        |    COLLECT src = e.src INTO g
        |    RETURN { [src]: LENGTH(g) }
        |)
        |FOR n IN nodes
        |  FILTER n.kind == "region" AND n.deleted_rev == null
        |  LET mf = n.attrs.member_files != null ? n.attrs.member_files : []
        |  FILTER LENGTH(mf) > 0
        |  LET file_count = LENGTH(mf)
        |  LET total_chunks = SUM(
        |    FOR f IN mf RETURN HAS(chunk_map, f) ? chunk_map[f] : 0
        |  )
        |  LET smell_count = LENGTH(
        |    FOR f IN mf FILTER f IN smell_ids RETURN 1
        |  )
        |  RETURN {
        |    region_id:    n.logical_id,
        |    name:         n.name,
        |    level:        n.attrs.level,
        |    label_kind:   n.attrs.label_kind,
        |    file_count:   file_count,
        |    total_chunks: total_chunks,
        |    smell_files:  smell_count,
        |    confidence:   n.attrs.confidence != null ? n.attrs.confidence : 0.0
        |  }""".stripMargin,
      Map.empty
    ).map(_.flatMap { json =>
      val c = json.hcursor
      for {
        regionId    <- c.get[String]("region_id").toOption
        name        <- c.get[String]("name").toOption
        level       <- c.get[Int]("level").toOption
        labelKind   <- c.get[String]("label_kind").toOption
        fileCount   <- c.get[Int]("file_count").toOption
        totalChunks <- c.get[Int]("total_chunks").toOption
        smellFiles  <- c.get[Int]("smell_files").toOption
        confidence  <- c.get[Double]("confidence").toOption
      } yield RawData(regionId, name, level, labelKind, fileCount, totalChunks, smellFiles, confidence)
    })

  // ── Scoring formula ─────────────────────────────────────────────────

  /**
   * Health score formula (from spec):
   *   0.4 × (1 − smell_rate) + 0.3 × tanh(chunk_density / 5) + 0.3 × confidence
   */
  private def computeScore(raw: RawData): Score = {
    val n            = raw.fileCount.toDouble.max(1)
    val chunkDensity = raw.totalChunks.toDouble / n
    val smellRate    = raw.smellFiles.toDouble / n
    val healthScore  = (0.4 * (1 - smellRate) +
                        0.3 * Math.tanh(chunkDensity / 5) +
                        0.3 * raw.confidence).max(0.0).min(1.0)
    Score(raw.regionId, raw.name, raw.level, raw.labelKind,
          raw.fileCount, healthScore, chunkDensity, smellRate,
          raw.smellFiles, raw.totalChunks, raw.confidence)
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private def retireOldScores(): IO[Unit] =
    client.execute(
      """FOR c IN claims
        |  FILTER c.field == "subsystem_health" AND c.deleted_rev == null
        |  REMOVE c IN claims""".stripMargin,
      Map.empty
    )

  private def storeScores(scores: List[Score], rev: Long): IO[Unit] =
    if (scores.isEmpty) IO.unit
    else {
      val docs = scores.map { s =>
        val key   = UUID.nameUUIDFromBytes(s"subsystem:${s.regionId}".getBytes("UTF-8")).toString
        val value = encodeScore(s)
        val doc   = new java.util.HashMap[String, AnyRef]()
        doc.put("_key",        key)
        doc.put("entity_id",   s.regionId)
        doc.put("field",       "subsystem_health")
        doc.put("value",       mapper.readValue(value.noSpaces, classOf[AnyRef]))
        doc.put("confidence",  java.lang.Double.valueOf(s.healthScore))
        doc.put("status",      "active")
        doc.put("created_rev", Long.box(rev))
        doc.put("deleted_rev", null)
        doc: java.util.Map[String, AnyRef]
      }
      client.bulkInsert("claims", docs, "replace").void
    }

  // ── Encoding ────────────────────────────────────────────────────────

  private def encodeScore(s: Score): Json =
    Json.obj(
      "region_id"         -> s.regionId.asJson,
      "name"              -> s.name.asJson,
      "level"             -> s.level.asJson,
      "label_kind"        -> s.labelKind.asJson,
      "file_count"        -> s.fileCount.asJson,
      "health_score"      -> s.healthScore.asJson,
      "chunk_density"     -> s.chunkDensity.asJson,
      "smell_rate"        -> s.smellRate.asJson,
      "smell_files"       -> s.smellFiles.asJson,
      "total_chunks"      -> s.totalChunks.asJson,
      "confidence"        -> s.confidence.asJson,
      "inference_version" -> InferenceVersion.asJson
    )
}
