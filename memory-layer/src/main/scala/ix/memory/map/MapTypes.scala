package ix.memory.map

import ix.memory.model.NodeId

/** A file node with its UUID and path (used as label source). */
final case class FileVertex(id: NodeId, path: String)

/** Raw edge from ArangoDB before weight computation. */
final case class RawFilePair(srcId: String, dstId: String, predicate: String, count: Int)

/** Weighted edge between two file nodes (symmetric — both directions stored). */
final case class FileCouplingEdge(src: NodeId, dst: NodeId, weight: Double, dominant: String)

/**
 * Weighted, undirected file-level coupling graph.
 *
 * adjMatrix is symmetric: adjMatrix(a)(b) == adjMatrix(b)(a)
 * totalWeight is the sum of all weights counting each edge once.
 */
final case class WeightedFileGraph(
  vertices:    Vector[FileVertex],
  adjMatrix:   Map[NodeId, Map[NodeId, Double]],
  degrees:     Map[NodeId, Double],
  totalWeight: Double,
  predicatePairs: Map[(NodeId, NodeId), Map[String, Int]]
)

object WeightedFileGraph {
  val empty: WeightedFileGraph =
    WeightedFileGraph(Vector.empty, Map.empty, Map.empty, 0.0, Map.empty)
}

/**
 * A single inferred architectural region at one level of the hierarchy.
 *
 * `memberFiles` always refers to the original file NodeIds.
 * `parentId` is set for regions at level >= 2 (their containing region at level+1).
 */
final case class Region(
  id:              NodeId,
  label:           String,
  labelKind:       String,        // "module" | "subsystem" | "system"
  level:           Int,           // 1 = finest, 2 = mid, 3 = coarse
  memberFiles:     Set[NodeId],
  childRegionIds:  Set[NodeId],   // direct children at level-1 (empty for level 1)
  parentId:        Option[NodeId],
  cohesion:        Double,
  externalCoupling: Double,
  boundaryRatio:   Double,
  confidence:      Double,
  crosscutScore:   Double,
  dominantSignals: List[String],
  interfaceNodeCount: Int,
  mapRev:          Long
)

// ── Preflight types ──────────────────────────────────────────────────

sealed trait RiskTier { def label: String }
object RiskTier {
  case object Low     extends RiskTier { val label = "Low" }
  case object Medium  extends RiskTier { val label = "Medium" }
  case object High    extends RiskTier { val label = "High" }
  case object Extreme extends RiskTier { val label = "Extreme" }
}

sealed trait MapExecutionMode { def label: String }
object MapExecutionMode {
  case object FullLocal extends MapExecutionMode { val label = "FullLocal" }
  case object FastLocal extends MapExecutionMode { val label = "FastLocal" }
}

final case class LocalCapacity(
  cpuCores:        Int,
  heapMaxBytes:    Long,
  heapFreeBytes:   Long,
  containerMemory: Option[Long],
  diskFreeBytes:   Option[Long]
)

final case class CostEstimate(
  fileCount:          Int,
  directoryCount:     Int,
  directoryQuadratic: Long,
  symbolEstimate:     Long,
  edgeEstimate:       Long
)

final case class MapPreflightResult(
  cost:       CostEstimate,
  capacity:   LocalCapacity,
  risk:       RiskTier,
  mode:       MapExecutionMode,
  warnings:   Vector[String],
  durationMs: Long
)

// ── Outcome and guardrail types ──────────────────────────────────────

sealed trait MapOutcome { def label: String }
object MapOutcome {
  case object FullLocalCompleted    extends MapOutcome { val label = "full_local_completed" }
  case object FastLocalCompleted    extends MapOutcome { val label = "fast_local_completed" }
  case object LocalMapTooLarge     extends MapOutcome { val label = "local_map_too_large" }
  case object LocalMapNotRecommended extends MapOutcome { val label = "local_map_not_recommended" }
}

final case class PersistenceEstimate(
  regionNodes:  Int,
  fileEdges:    Int,
  regionEdges:  Int,
  deleteOps:    Int,
  totalOps:     Int
)

/**
 * Structured exception for map capacity failures.
 *
 * Carries the outcome category, a user-facing message, and a next-step
 * suggestion so the error handler can produce clean structured JSON
 * without relying on ad-hoc exception parsing.
 */
class MapCapacityException(
  val outcome: MapOutcome,
  val userMessage: String,
  val next: String
) extends RuntimeException(userMessage)

/** The full multi-level architecture map returned by MapService. */
final case class ArchitectureMap(
  regions:              Vector[Region],
  fileCount:            Int,
  mapRev:               Long,
  preflight:            Option[MapPreflightResult] = None,
  outcome:              MapOutcome = MapOutcome.FullLocalCompleted,
  persistenceEstimate:  Option[PersistenceEstimate] = None
)

final case class RegionMatch(
  region: Region,
  matchQuality: Int,
  normalizedLabel: String
)

final case class ScopedHealthSummary(
  wellDefined: Int,
  moderate: Int,
  fuzzy: Int,
  crossCutting: Int
)

final case class ScopedSubsystemView(
  target: Region,
  parent: Option[Region],
  children: Vector[Region],
  subtree: Vector[Region],
  summary: ScopedHealthSummary
)
