package ix.memory.subsystem

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._

import ix.memory.db.{ArangoClient, GraphWriteApi}
import ix.memory.map.MapService
import ix.memory.model._

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

final case class SubsystemScore(
  regionId:     String,
  regionName:   String,
  level:        Int,
  labelKind:    String,
  fileCount:    Int,
  totalChunks:  Int,
  smellFiles:   Int,
  confidence:   Double,
  chunkDensity: Double,
  smellRate:    Double,
  healthScore:  Double
)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Computes evidence-based health scores for each architectural region (subsystem).
 *
 * Score formula (range 0–1):
 *   health = 0.4*(1 − smellRate) + 0.3*tanh(chunkDensity/5) + 0.3*confidence
 *
 * Signals:
 *   chunkDensity  — avg CONTAINS_CHUNK edges per member file (more = richer structure)
 *   smellRate     — fraction of member files that have an active smell claim (lower = healthier)
 *   confidence    — MapService cohesion/boundary score carried from the region node
 *
 * Results stored as `has_score.subsystem_health` claims on Region nodes,
 * with inferenceVersion = "subsystem_v1".
 */
class SubsystemScoringService(
  client: ArangoClient,
  writeApi: GraphWriteApi,
  mapService: MapService
) {

  private val InferenceVersion = "subsystem_v1"
  private val Actor            = "ix/subsystem-scorer"
  private val ScoreField       = "has_score.subsystem_health"

  /** Run scoring: query chunk/smell metrics, compute health, persist claims. */
  def score(): IO[Vector[SubsystemScore]] =
    for {
      archMap <- mapService.getOrBuildMap()
      rows    <- queryRegionMetrics(archMap.regions.map(_.id.value.toString), archMap.mapRev)
      scores   = rows.flatMap(computeScore)
      _      <- persistScores(scores)
    } yield scores

  /** Retrieve previously stored health-score claims joined with region metadata. */
  def listScores(): IO[Vector[Json]] =
    client.query(
      """FOR r IN nodes
        |  FILTER r.kind == "region" AND r.deleted_rev == null
        |  LET score_claim = FIRST(
        |    FOR c IN claims
        |      FILTER c.entity_id == r.logical_id
        |        AND c.field == "has_score.subsystem_health"
        |        AND c.status == "active"
        |        AND c.deleted_rev == null
        |      SORT c.created_rev DESC
        |      LIMIT 1
        |      RETURN c
        |  )
        |  FILTER score_claim != null
        |  SORT score_claim.value.health_score DESC
        |  RETURN {
        |    region_id:         r.logical_id,
        |    name:              r.name,
        |    level:             r.attrs.level,
        |    label_kind:        r.attrs.label_kind,
        |    file_count:        r.attrs.file_count,
        |    health_score:      score_claim.value.health_score,
        |    chunk_density:     score_claim.value.chunk_density,
        |    smell_rate:        score_claim.value.smell_rate,
        |    smell_files:       score_claim.value.smell_files,
        |    total_chunks:      score_claim.value.total_chunks,
        |    confidence:        score_claim.value.confidence,
        |    inference_version: score_claim.inference_version
        |  }""".stripMargin,
      Map.empty
    ).map(_.toVector)

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Single AQL pass: for each region node, count CONTAINS_CHUNK edges across
   * member files, and count distinct member files that have any smell claim.
   */
  private def queryRegionMetrics(regionIds: Vector[String], mapRev: Long): IO[Vector[Json]] =
    if (regionIds.isEmpty) IO.pure(Vector.empty)
    else
    client.query(
      """FOR r IN nodes
        |  FILTER r.kind == "region" AND r.deleted_rev == null
        |    AND r.logical_id IN @regionIds
        |    AND TO_NUMBER(r.attrs.map_rev) == @mapRev
        |  LET chunk_count = LENGTH(
        |    FOR e IN edges
        |      FILTER e.src IN r.attrs.member_files
        |        AND e.predicate == "CONTAINS_CHUNK"
        |        AND e.deleted_rev == null
        |      RETURN 1
        |  )
        |  LET smell_files = LENGTH(UNIQUE(
        |    FOR c IN claims
        |      FILTER c.entity_id IN r.attrs.member_files
        |        AND STARTS_WITH(c.field, "has_smell.")
        |        AND c.status == "active"
        |        AND c.deleted_rev == null
        |      RETURN c.entity_id
        |  ))
        |  RETURN {
        |    id:          r.logical_id,
        |    name:        r.name,
        |    level:       r.attrs.level,
        |    label_kind:  r.attrs.label_kind,
        |    file_count:  r.attrs.file_count,
        |    confidence:  r.attrs.confidence,
        |    chunk_count: chunk_count,
        |    smell_files: smell_files
        |  }""".stripMargin,
      Map(
        "regionIds" -> regionIds.toArray.asInstanceOf[AnyRef],
        "mapRev"    -> Long.box(mapRev).asInstanceOf[AnyRef]
      )
    ).map(_.toVector)

  private def computeScore(json: Json): Option[SubsystemScore] = {
    val c = json.hcursor
    for {
      regionId   <- c.get[String]("id").toOption
      regionName <- c.get[String]("name").toOption
    } yield {
      val level        = c.get[Int]("level").getOrElse(1)
      val labelKind    = c.get[String]("label_kind").getOrElse("module")
      val fileCount    = c.get[Int]("file_count").getOrElse(1).max(1)
      val confidence   = c.get[Double]("confidence").getOrElse(0.0)
      val totalChunks  = c.get[Int]("chunk_count").getOrElse(0)
      val smellFiles   = c.get[Int]("smell_files").getOrElse(0)

      val chunkDensity = totalChunks.toDouble / fileCount
      val smellRate    = smellFiles.toDouble / fileCount
      val normDensity  = Math.tanh(chunkDensity / 5.0)
      val healthScore  = (0.4 * (1.0 - smellRate) + 0.3 * normDensity + 0.3 * confidence)
                          .max(0.0).min(1.0)

      SubsystemScore(
        regionId     = regionId,
        regionName   = regionName,
        level        = level,
        labelKind    = labelKind,
        fileCount    = fileCount,
        totalChunks  = totalChunks,
        smellFiles   = smellFiles,
        confidence   = confidence,
        chunkDensity = chunkDensity,
        smellRate    = smellRate,
        healthScore  = healthScore
      )
    }
  }

  private def persistScores(scores: Vector[SubsystemScore]): IO[Long] = {
    if (scores.isEmpty) return IO.pure(0L)

    val ops: Vector[PatchOp] = scores.flatMap { s =>
      scala.util.Try(UUID.fromString(s.regionId)).toOption.map { uuid =>
        PatchOp.AssertClaim(
          entityId         = NodeId(uuid),
          field            = ScoreField,
          value            = Json.obj(
            "health_score"  -> s.healthScore.asJson,
            "chunk_density" -> s.chunkDensity.asJson,
            "smell_rate"    -> s.smellRate.asJson,
            "smell_files"   -> s.smellFiles.asJson,
            "total_chunks"  -> s.totalChunks.asJson,
            "file_count"    -> s.fileCount.asJson,
            "confidence"    -> s.confidence.asJson
          ),
          confidence       = Some(s.healthScore),
          inferenceVersion = Some(InferenceVersion)
        )
      }
    }

    val patch = GraphPatch(
      patchId   = PatchId(UUID.randomUUID()),
      actor     = Actor,
      timestamp = Instant.now(),
      source    = PatchSource(
        uri        = "ix://subsystem-scorer",
        sourceHash = None,
        extractor  = s"subsystem-scorer/$InferenceVersion",
        sourceType = SourceType.Inferred
      ),
      baseRev   = Rev(0L),
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some(s"Subsystem health scoring: ${scores.size} regions")
    )

    writeApi.commitPatch(patch).map(_.newRev.value)
  }
}
