package ix.memory.smell

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.parallel._
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
      results    <- (detectOrphans(config), detectGodModules(config), detectWeakComponents(config)).parTupled
      (orphans, godMods, weakComps) = results
      candidates  = orphans ++ godMods ++ weakComps
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

  // ── Detectors (3 parallel, no MERGE maps — memory-safe) ──────────────────

  private def detectOrphans(cfg: SmellConfig): IO[Vector[SmellCandidate]] =
    client.query(
      // Per-file edge counts via subquery against indexed src/dst fields.
      // No global aggregation — each file only touches its own edges.
      """FOR f IN nodes
        |  FILTER f.kind == "file" AND f.deleted_rev == null
        |  LET imports_out = LENGTH(FOR e IN edges FILTER e.src == f.logical_id AND e.predicate == "IMPORTS" AND e.deleted_rev == null RETURN 1)
        |  LET imports_in  = LENGTH(FOR e IN edges FILTER e.dst == f.logical_id AND e.predicate == "IMPORTS" AND e.deleted_rev == null RETURN 1)
        |  LET calls_out   = LENGTH(FOR e IN edges FILTER e.src == f.logical_id AND e.predicate == "CALLS"   AND e.deleted_rev == null RETURN 1)
        |  LET calls_in    = LENGTH(FOR e IN edges FILTER e.dst == f.logical_id AND e.predicate == "CALLS"   AND e.deleted_rev == null RETURN 1)
        |  LET connectivity = imports_out + imports_in + calls_out + calls_in
        |  FILTER connectivity <= @threshold
        |  RETURN {
        |    logical_id: f.logical_id, name: f.name,
        |    imports_out, imports_in, calls_out, calls_in, connectivity
        |  }""".stripMargin,
      Map("threshold" -> Int.box(cfg.orphanMaxConnections).asInstanceOf[AnyRef])
    ).map(_.flatMap { json =>
      for {
        id           <- json.hcursor.get[String]("logical_id").toOption
        name         <- json.hcursor.get[String]("name").toOption
        connectivity <- json.hcursor.get[Int]("connectivity").toOption
        importsOut   <- json.hcursor.get[Int]("imports_out").toOption
        importsIn    <- json.hcursor.get[Int]("imports_in").toOption
        callsOut     <- json.hcursor.get[Int]("calls_out").toOption
        callsIn      <- json.hcursor.get[Int]("calls_in").toOption
      } yield SmellCandidate(
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
    }.toVector)

  private def detectGodModules(cfg: SmellConfig): IO[Vector[SmellCandidate]] =
    client.query(
      """FOR f IN nodes
        |  FILTER f.kind == "file" AND f.deleted_rev == null
        |  LET chunks  = LENGTH(FOR e IN edges FILTER e.src == f.logical_id AND e.predicate == "CONTAINS_CHUNK" AND e.deleted_rev == null RETURN 1)
        |  LET symbols = LENGTH(FOR e IN edges FILTER e.src == f.logical_id AND e.predicate == "CONTAINS"       AND e.deleted_rev == null RETURN 1)
        |  LET fan_out = LENGTH(FOR e IN edges FILTER e.src == f.logical_id AND e.predicate == "IMPORTS"         AND e.deleted_rev == null RETURN 1)
        |  LET fan_in  = LENGTH(FOR e IN edges FILTER e.dst == f.logical_id AND e.predicate == "IMPORTS"         AND e.deleted_rev == null RETURN 1)
        |  FILTER chunks >= @chunkThreshold OR fan_in >= @fanThreshold OR fan_out >= @fanThreshold
        |  RETURN { logical_id: f.logical_id, name: f.name, chunks, symbols, fan_in, fan_out }""".stripMargin,
      Map(
        "chunkThreshold" -> Int.box(cfg.godModuleChunkThreshold).asInstanceOf[AnyRef],
        "fanThreshold"   -> Int.box(cfg.godModuleFanThreshold).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap { json =>
      for {
        id      <- json.hcursor.get[String]("logical_id").toOption
        name    <- json.hcursor.get[String]("name").toOption
        chunks  <- json.hcursor.get[Int]("chunks").toOption
        symbols <- json.hcursor.get[Int]("symbols").toOption
        fanIn   <- json.hcursor.get[Int]("fan_in").toOption
        fanOut  <- json.hcursor.get[Int]("fan_out").toOption
      } yield {
        val triggeredSignals = Seq(
          Option.when(chunks >= cfg.godModuleChunkThreshold)(s"chunks=$chunks"),
          Option.when(fanIn  >= cfg.godModuleFanThreshold)(s"fan_in=$fanIn"),
          Option.when(fanOut >= cfg.godModuleFanThreshold)(s"fan_out=$fanOut")
        ).flatten
        SmellCandidate(
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
    }.toVector)

  private def detectWeakComponents(cfg: SmellConfig): IO[Vector[SmellCandidate]] =
    client.query(
      """FOR f IN nodes
        |  FILTER f.kind == "file" AND f.deleted_rev == null
        |  LET out_nbrs = (FOR e IN edges FILTER e.src == f.logical_id AND e.predicate IN ["IMPORTS","CALLS"] AND e.deleted_rev == null RETURN DISTINCT e.dst)
        |  LET in_nbrs  = (FOR e IN edges FILTER e.dst == f.logical_id AND e.predicate IN ["IMPORTS","CALLS"] AND e.deleted_rev == null RETURN DISTINCT e.src)
        |  LET neighbor_count = LENGTH(UNION_DISTINCT(out_nbrs, in_nbrs))
        |  FILTER neighbor_count > 0 AND neighbor_count <= @maxNeighbors
        |  RETURN { logical_id: f.logical_id, name: f.name, neighbor_count }""".stripMargin,
      Map("maxNeighbors" -> Int.box(cfg.weakComponentMaxNeighbors).asInstanceOf[AnyRef])
    ).map(_.flatMap { json =>
      for {
        id            <- json.hcursor.get[String]("logical_id").toOption
        name          <- json.hcursor.get[String]("name").toOption
        neighborCount <- json.hcursor.get[Int]("neighbor_count").toOption
      } yield SmellCandidate(
        fileId     = id,
        fileName   = name,
        smellKind  = SmellKind.WeakComponent,
        confidence = 0.55,
        signals    = Map("neighbor_count" -> neighborCount.asJson)
      )
    }.toVector)

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
