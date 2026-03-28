package ix.memory.smell

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.traverse._
import io.circe.Json
import io.circe.syntax._

import ix.memory.db.{ArangoClient, GraphWriteApi}
import ix.memory.model._

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

sealed trait SmellKind { def field: String }
object SmellKind {
  case object OrphanFile        extends SmellKind { val field = "has_smell.orphan_file"        }
  case object GodModule         extends SmellKind { val field = "has_smell.god_module"          }
  case object WeakComponent     extends SmellKind { val field = "has_smell.weak_component_member" }
}

final case class SmellCandidate(
  fileId:     String,   // logical_id UUID
  fileName:   String,
  smellKind:  SmellKind,
  confidence: Double,
  signals:    Map[String, Json]   // evidence key → value
)

final case class SmellConfig(
  /** Max total edge connectivity for a file to be an orphan candidate. */
  orphanMaxConnections: Int = 0,
  /** Min chunk count to flag a god module. */
  godModuleChunkThreshold: Int = 20,
  /** Min fan-in or fan-out (IMPORTS edges) to flag a god module. */
  godModuleFanThreshold: Int = 15,
  /** Max unique file neighbors for a weak-component candidate. */
  weakComponentMaxNeighbors: Int = 1
)

final case class SmellReport(
  candidates: Vector[SmellCandidate],
  rev:        Long,
  runAt:      String
)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SmellService(client: ArangoClient, writeApi: GraphWriteApi) {

  private val InferenceVersion = "smell_v1"
  private val Actor            = "ix/smell"

  def run(config: SmellConfig = SmellConfig()): IO[SmellReport] =
    for {
      candidates <- detectAll(config)
      rev        <- commitSmells(candidates)
    } yield SmellReport(candidates, rev, Instant.now().toString)

  /** Retrieve existing smell claims from the graph without rerunning detection. */
  def listSmells(): IO[Vector[Json]] =
    client.query(
      """FOR c IN claims
        |  FILTER STARTS_WITH(c.field, "has_smell.")
        |    AND c.status == "active"
        |    AND c.deleted_rev == null
        |  SORT c.entity_id, c.field
        |  RETURN {
        |    entity_id: c.entity_id,
        |    smell:     c.field,
        |    value:     c.value,
        |    inference_version: c.inference_version
        |  }""".stripMargin,
      Map.empty
    ).map(_.toVector)

  // ── Unified detector — single edge scan ──────────────────────────────────

  private def detectAll(cfg: SmellConfig): IO[Vector[SmellCandidate]] =
    client.query(
      // One pass over edges: aggregate counts by (id, predicate, direction)
      // and collect unique neighbors for weak-component detection.
      // Single-pass: one scan for counts (all predicates as src),
      // one scan for dst counts + neighbor collection (IMPORTS/CALLS only).
      """LET src_agg = (
        |  FOR e IN edges
        |    FILTER e.predicate IN ["IMPORTS","CALLS","CONTAINS","CONTAINS_CHUNK"]
        |      AND e.deleted_rev == null
        |    COLLECT id = e.src, pred = e.predicate WITH COUNT INTO cnt
        |    RETURN { id, pred, cnt }
        |)
        |LET dst_agg = (
        |  FOR e IN edges
        |    FILTER e.predicate IN ["IMPORTS","CALLS"]
        |      AND e.deleted_rev == null
        |    COLLECT id = e.dst, pred = e.predicate WITH COUNT INTO cnt
        |    RETURN { id, pred, cnt }
        |)
        |LET src_nbrs = (
        |  FOR e IN edges
        |    FILTER e.predicate IN ["IMPORTS","CALLS"] AND e.deleted_rev == null
        |    COLLECT id = e.src INTO dsts = e.dst
        |    RETURN { id, nbrs: dsts }
        |)
        |LET dst_nbrs = (
        |  FOR e IN edges
        |    FILTER e.predicate IN ["IMPORTS","CALLS"] AND e.deleted_rev == null
        |    COLLECT id = e.dst INTO srcs = e.src
        |    RETURN { id, nbrs: srcs }
        |)
        |LET sm = MERGE(FOR r IN src_agg RETURN { [CONCAT(r.id,":",r.pred)]: r.cnt })
        |LET dm = MERGE(FOR r IN dst_agg RETURN { [CONCAT(r.id,":",r.pred)]: r.cnt })
        |LET snm = MERGE(FOR r IN src_nbrs RETURN { [r.id]: r.nbrs })
        |LET dnm = MERGE(FOR r IN dst_nbrs RETURN { [r.id]: r.nbrs })
        |FOR f IN nodes
        |  FILTER f.kind == "file" AND f.deleted_rev == null
        |  LET imports_out = TO_NUMBER(sm[CONCAT(f.logical_id,":IMPORTS")])
        |  LET imports_in  = TO_NUMBER(dm[CONCAT(f.logical_id,":IMPORTS")])
        |  LET calls_out   = TO_NUMBER(sm[CONCAT(f.logical_id,":CALLS")])
        |  LET calls_in    = TO_NUMBER(dm[CONCAT(f.logical_id,":CALLS")])
        |  LET connectivity = imports_out + imports_in + calls_out + calls_in
        |  LET chunks  = TO_NUMBER(sm[CONCAT(f.logical_id,":CONTAINS_CHUNK")])
        |  LET symbols = TO_NUMBER(sm[CONCAT(f.logical_id,":CONTAINS")])
        |  LET fan_in  = imports_in
        |  LET fan_out = imports_out
        |  LET all_nbrs = UNIQUE(APPEND(
        |    TO_ARRAY(snm[f.logical_id]),
        |    TO_ARRAY(dnm[f.logical_id])
        |  ))
        |  LET neighbor_count = LENGTH(all_nbrs)
        |  LET is_orphan = connectivity <= @orphanThreshold
        |  LET is_god    = chunks >= @chunkThreshold
        |                  OR fan_in >= @fanThreshold
        |                  OR fan_out >= @fanThreshold
        |  LET is_weak   = neighbor_count > 0 AND neighbor_count <= @maxNeighbors
        |  FILTER is_orphan OR is_god OR is_weak
        |  RETURN {
        |    logical_id: f.logical_id, name: f.name,
        |    imports_out, imports_in, calls_out, calls_in, connectivity,
        |    chunks, symbols, fan_in, fan_out,
        |    neighbor_count,
        |    is_orphan, is_god, is_weak
        |  }""".stripMargin,
      Map(
        "orphanThreshold" -> Int.box(cfg.orphanMaxConnections).asInstanceOf[AnyRef],
        "chunkThreshold"  -> Int.box(cfg.godModuleChunkThreshold).asInstanceOf[AnyRef],
        "fanThreshold"    -> Int.box(cfg.godModuleFanThreshold).asInstanceOf[AnyRef],
        "maxNeighbors"    -> Int.box(cfg.weakComponentMaxNeighbors).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap { json =>
      val c = json.hcursor
      for {
        id             <- c.get[String]("logical_id").toOption
        name           <- c.get[String]("name").toOption
        importsOut     <- c.get[Int]("imports_out").toOption
        importsIn      <- c.get[Int]("imports_in").toOption
        callsOut       <- c.get[Int]("calls_out").toOption
        callsIn        <- c.get[Int]("calls_in").toOption
        connectivity   <- c.get[Int]("connectivity").toOption
        chunks         <- c.get[Int]("chunks").toOption
        symbols        <- c.get[Int]("symbols").toOption
        fanIn          <- c.get[Int]("fan_in").toOption
        fanOut         <- c.get[Int]("fan_out").toOption
        neighborCount  <- c.get[Int]("neighbor_count").toOption
        isOrphan       <- c.get[Boolean]("is_orphan").toOption
        isGod          <- c.get[Boolean]("is_god").toOption
        isWeak         <- c.get[Boolean]("is_weak").toOption
      } yield {
        val results = Vector.newBuilder[SmellCandidate]

        if (isOrphan)
          results += SmellCandidate(
            fileId     = id,
            fileName   = name,
            smellKind  = SmellKind.OrphanFile,
            confidence = if (connectivity == 0) 0.85 else 0.6,
            signals    = Map(
              "connectivity" -> connectivity.asJson,
              "imports_out"  -> importsOut.asJson,
              "imports_in"   -> importsIn.asJson,
              "calls_out"    -> callsOut.asJson,
              "calls_in"     -> callsIn.asJson
            )
          )

        if (isGod) {
          val triggeredSignals = Seq(
            Option.when(chunks >= cfg.godModuleChunkThreshold)(s"chunks=$chunks"),
            Option.when(fanIn  >= cfg.godModuleFanThreshold)(s"fan_in=$fanIn"),
            Option.when(fanOut >= cfg.godModuleFanThreshold)(s"fan_out=$fanOut")
          ).flatten
          results += SmellCandidate(
            fileId     = id,
            fileName   = name,
            smellKind  = SmellKind.GodModule,
            confidence = Math.min(0.5 + triggeredSignals.size * 0.15, 0.9),
            signals    = Map(
              "chunks"   -> chunks.asJson,
              "symbols"  -> symbols.asJson,
              "fan_in"   -> fanIn.asJson,
              "fan_out"  -> fanOut.asJson,
              "triggers" -> triggeredSignals.asJson
            )
          )
        }

        if (isWeak)
          results += SmellCandidate(
            fileId     = id,
            fileName   = name,
            smellKind  = SmellKind.WeakComponent,
            confidence = 0.55,
            signals    = Map("neighbor_count" -> neighborCount.asJson)
          )

        results.result()
      }
    }.flatten.toVector)

  // ── Claim persistence ────────────────────────────────────────────────────

  private def commitSmells(candidates: Vector[SmellCandidate]): IO[Long] = {
    if (candidates.isEmpty) return client.query(
      "FOR rev IN latest_rev SORT rev.value DESC LIMIT 1 RETURN rev.value",
      Map.empty
    ).map(_.headOption.flatMap(_.as[Long].toOption).getOrElse(0L))

    val ops: Vector[PatchOp] = candidates.map { c =>
      PatchOp.AssertClaim(
        entityId         = NodeId(UUID.fromString(c.fileId)),
        field            = c.smellKind.field,
        value            = Json.obj(
          "confidence" -> c.confidence.asJson,
          "signals"    -> c.signals.asJson,
          "file"       -> c.fileName.asJson
        ),
        confidence       = Some(c.confidence),
        inferenceVersion = Some(InferenceVersion)
      )
    }

    val patchId   = PatchId(UUID.randomUUID())
    val sourceHash = UUID.nameUUIDFromBytes(s"smell_run:${Instant.now()}".getBytes("UTF-8")).toString
    val patch = GraphPatch(
      patchId   = patchId,
      actor     = Actor,
      timestamp = Instant.now(),
      source    = PatchSource(
        uri        = "ix://smell-detector",
        sourceHash = Some(sourceHash),
        extractor  = s"smell-detector/$InferenceVersion",
        sourceType = SourceType.Code
      ),
      baseRev   = Rev(0L),
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some(s"Smell detection: ${candidates.size} candidates")
    )

    writeApi.commitPatch(patch).map(_.newRev.value)
  }
}
