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
  totalWeight: Double
)

object WeightedFileGraph {
  val empty: WeightedFileGraph =
    WeightedFileGraph(Vector.empty, Map.empty, Map.empty, 0.0)
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

/** The full multi-level architecture map returned by MapService. */
final case class ArchitectureMap(
  regions:   Vector[Region],
  fileCount: Int,
  mapRev:    Long
)
