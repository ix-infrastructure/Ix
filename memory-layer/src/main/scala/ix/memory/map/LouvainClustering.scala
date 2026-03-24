package ix.memory.map

import java.util.UUID

import ix.memory.model.NodeId

import scala.util.Random

/**
 * Louvain community detection with recursive graph coarsening.
 *
 * Produces multi-level partitions: each level groups the original file nodes
 * into progressively coarser communities.
 *
 * Algorithm:
 *   1. Initialize each node in its own community.
 *   2. For each node (random order), try moving it to a neighbor's community.
 *      Accept if the modularity gain ΔQ > 0.
 *   3. Repeat until no improvement or max passes reached.
 *   4. Collapse communities into supernodes; rebuild weighted graph.
 *   5. Repeat on the coarsened graph.
 *   6. Project all levels back to original file IDs.
 *
 * Modularity gain formula (standard Louvain):
 *   ΔQ(i → C) = k_i_in(C) / m − γ · Σ_tot(C) · k_i / (2m²)
 *
 * where:
 *   k_i_in(C) = sum of edge weights from node i to nodes in community C
 *   Σ_tot(C)  = sum of all node degrees in C
 *   k_i       = degree of node i
 *   m         = total edge weight (each undirected edge counted once)
 *   γ         = resolution parameter (1.0 by default)
 */
object LouvainClustering {

  /** A partition of original file NodeIds into communities at one hierarchy level. */
  final case class LevelPartition(
    communities:  Vector[Set[NodeId]],       // each Set is a community of original file IDs
    assignment:   Map[NodeId, Int]           // fileId → community index
  )

  /**
   * Run multi-level Louvain clustering.
   *
   * Returns a vector of LevelPartitions, finest first (index 0 = most granular).
   * Each partition covers ALL original file nodes.
   */
  def cluster(
    graph:              WeightedFileGraph,
    maxLevels:          Int    = 4,
    resolution:         Double = -1.0,
    minCommunitySize:   Int    = 2,
    seed:               Long   = 42L
  ): Vector[LevelPartition] = {
    if (graph.vertices.isEmpty || graph.totalWeight == 0.0) return Vector.empty

    val effectiveResolution =
      if (resolution > 0.0) resolution else adaptiveResolution(graph.vertices.size)

    val numSeeds = if (graph.vertices.size < 30) 1L else 3L
    val runs = (0L until numSeeds).map { offset =>
      val levels = clusterOnce(
        graph            = graph,
        maxLevels        = maxLevels,
        resolution       = effectiveResolution,
        minCommunitySize = minCommunitySize,
        seed             = seed + offset
      )
      val score = levels.headOption
        .map(level => modularity(graph, level.assignment, effectiveResolution))
        .getOrElse(Double.NegativeInfinity)
      levels -> score
    }

    runs.maxBy(_._2)._1
  }

  private def clusterOnce(
    graph:            WeightedFileGraph,
    maxLevels:        Int,
    resolution:       Double,
    minCommunitySize: Int,
    seed:             Long
  ): Vector[LevelPartition] = {
    val rng = new Random(seed)

    var nodeExpansion: Map[NodeId, Set[NodeId]] =
      graph.vertices.map(v => v.id -> Set(v.id)).toMap

    var currentGraph = graph
    val levels       = scala.collection.mutable.ArrayBuffer.empty[LevelPartition]

    var level = 0
    while (level < maxLevels && currentGraph.vertices.size > 1) {
      val rawAssignment = louvainPass(currentGraph, resolution, rng)
      val projected     = projectPartition(rawAssignment, nodeExpansion)
      val meaningful    = projected.communities.count(_.size >= minCommunitySize)

      if (meaningful <= 1 && levels.nonEmpty) {
        level = maxLevels
      } else {
        levels += projected

        val (coarsenedGraph, newExpansion) =
          coarsen(currentGraph, rawAssignment, nodeExpansion)

        nodeExpansion  = newExpansion
        currentGraph   = coarsenedGraph
        level         += 1

        if (currentGraph.vertices.size < 3) level = maxLevels
      }
    }

    levels.toVector
  }

  private def adaptiveResolution(fileCount: Int): Double =
    if (fileCount < 50) 1.2
    else if (fileCount <= 500) 1.0
    else 0.8

  // ── Single Louvain pass ────────────────────────────────────────────

  /**
   * One full Louvain pass on the given graph.
   * Returns assignment: nodeId → community index (indices are 0-based, dense).
   */
  private def louvainPass(
    graph:      WeightedFileGraph,
    resolution: Double,
    rng:        Random
  ): Map[NodeId, Int] = {
    val nodes = graph.vertices.map(_.id).toArray
    val adj   = graph.adjMatrix
    val m     = graph.totalWeight.max(1e-12)

    // Initialize: node i → community i
    val commOf  = scala.collection.mutable.Map(nodes.zipWithIndex: _*)
    val sumTot  = scala.collection.mutable.Map(
      nodes.zipWithIndex.map { case (n, i) => i -> graph.degrees.getOrElse(n, 0.0) }: _*
    ).withDefaultValue(0.0)
    // communities: commId → members (mutable set)
    val members = scala.collection.mutable.Map(
      nodes.zipWithIndex.map { case (n, i) => i -> scala.collection.mutable.Set(n) }: _*
    )

    var continue = true
    val wToComm = scala.collection.mutable.HashMap.empty[Int, Double]

    while (continue) {
      shuffleInPlace(nodes, rng)
      var improved = false
      var passGain = 0.0

      var idx = 0
      while (idx < nodes.length) {
        val node = nodes(idx)
        val ci = commOf(node)
        val ki = graph.degrees.getOrElse(node, 0.0)

        // Compute weight from this node to each neighboring community
        wToComm.clear()
        for ((neighbor, w) <- adj.getOrElse(node, Map.empty)) {
          val community = commOf(neighbor)
          wToComm.update(community, wToComm.getOrElse(community, 0.0) + w)
        }

        // Remove node from current community
        val kiInCi = wToComm.getOrElse(ci, 0.0)
        sumTot(ci) -= ki
        members(ci) -= node
        // Temporarily isolate: treat as its own community (gains = 0 baseline)
        commOf(node) = -1

        var bestComm = ci
        var bestGain = 0.0

        for ((cj, kiInCj) <- wToComm if cj != -1) {
          val dQ = kiInCj / m - resolution * sumTot.getOrElse(cj, 0.0) * ki / (2.0 * m * m)
          if (dQ > bestGain) {
            bestGain = dQ
            bestComm = cj
          }
        }

        // Place node in best community (or back in its old one if no improvement)
        commOf(node) = bestComm
        members.getOrElseUpdate(bestComm, scala.collection.mutable.Set()) += node
        val kiInBest = wToComm.getOrElse(bestComm, 0.0)
        sumTot(bestComm) += ki

        if (bestComm != ci) {
          improved = true
          passGain += bestGain
        }
        idx += 1
      }

      continue = improved && passGain >= 1e-6
    }

    // Re-index communities from 0 to N-1 (dense)
    val nonEmpty     = members.filter(_._2.nonEmpty).toMap
    val reindex      = nonEmpty.keys.toVector.sorted.zipWithIndex.toMap
    val finalAssign  = commOf.map { case (n, c) =>
      n -> reindex.getOrElse(c, 0)
    }.toMap

    finalAssign
  }

  private def shuffleInPlace(nodes: Array[NodeId], rng: Random): Unit = {
    var i = nodes.length - 1
    while (i > 0) {
      val j = rng.nextInt(i + 1)
      val tmp = nodes(i)
      nodes(i) = nodes(j)
      nodes(j) = tmp
      i -= 1
    }
  }

  private def modularity(
    graph:      WeightedFileGraph,
    assignment: Map[NodeId, Int],
    resolution: Double
  ): Double = {
    val communities = assignment.groupBy(_._2).map { case (idx, entries) => idx -> entries.keySet }
    val m = graph.totalWeight.max(1e-12)

    communities.values.foldLeft(0.0) { (acc, members) =>
      val totalDegree = members.iterator.map(node => graph.degrees.getOrElse(node, 0.0)).sum
      var internalWeight = 0.0
      for {
        src <- members
        (dst, weight) <- graph.adjMatrix.getOrElse(src, Map.empty)
        if members.contains(dst) && src.value.compareTo(dst.value) < 0
      } internalWeight += weight

      acc + (internalWeight / m) - resolution * math.pow(totalDegree / (2.0 * m), 2.0)
    }
  }

  // ── Projection ─────────────────────────────────────────────────────

  private def projectPartition(
    assignment:    Map[NodeId, Int],
    nodeExpansion: Map[NodeId, Set[NodeId]]
  ): LevelPartition = {
    // Map: community index → set of original file IDs
    val comms = scala.collection.mutable.Map[Int, scala.collection.mutable.Set[NodeId]]()
    for ((node, commIdx) <- assignment) {
      val origFiles = nodeExpansion.getOrElse(node, Set(node))
      comms.getOrElseUpdate(commIdx, scala.collection.mutable.Set()) ++= origFiles
    }

    val commVec  = comms.toVector.sortBy(_._1).map(_._2.toSet)
    // Build reverse assignment: origFileId → commIdx
    val reverseAssign = (for ((members, idx) <- commVec.zipWithIndex; f <- members) yield f -> idx).toMap

    LevelPartition(commVec, reverseAssign)
  }

  // ── Graph coarsening ────────────────────────────────────────────────

  /**
   * Collapse each community in `assignment` into a single supernode.
   * Returns the coarsened graph and an updated nodeExpansion map.
   */
  private def coarsen(
    graph:         WeightedFileGraph,
    assignment:    Map[NodeId, Int],
    nodeExpansion: Map[NodeId, Set[NodeId]]
  ): (WeightedFileGraph, Map[NodeId, Set[NodeId]]) = {
    // Group current nodes by community
    val commGroups: Map[Int, Set[NodeId]] =
      assignment.groupBy(_._2).map { case (k, v) => k -> v.keySet }

    // Assign a deterministic new NodeId to each community (based on sorted member UUIDs)
    val commToSuper: Map[Int, NodeId] = commGroups.map { case (ci, members) =>
      val key = "map:super:" + members.map(_.value.toString).toList.sorted.mkString(",")
      ci -> NodeId(UUID.nameUUIDFromBytes(key.getBytes("UTF-8")))
    }

    // Build supernode expansion
    val newExpansion: Map[NodeId, Set[NodeId]] = commGroups.map { case (ci, members) =>
      val origFiles = members.flatMap(n => nodeExpansion.getOrElse(n, Set(n)))
      commToSuper(ci) -> origFiles
    }

    // Build supernode vertices (use community index as label for debugging)
    val superVertices = commToSuper.map { case (ci, superId) =>
      FileVertex(superId, s"supernode_$ci")
    }.toVector

    // Aggregate inter-community edges
    val edgeWeights =
      scala.collection.mutable.Map[(NodeId, NodeId), Double]()

    for ((src, neighbors) <- graph.adjMatrix) {
      val ci = assignment.getOrElse(src, -1)
      if (ci >= 0) {
        val si = commToSuper(ci)
        for ((dst, w) <- neighbors) {
          val cj = assignment.getOrElse(dst, -1)
          if (cj >= 0 && ci != cj) {
            val sj  = commToSuper(cj)
            val key = if (si.value.compareTo(sj.value) < 0) (si, sj) else (sj, si)
            edgeWeights(key) = edgeWeights.getOrElse(key, 0.0) + w / 2.0  // undirected: each pair counted twice in adj
          }
        }
      }
    }

    // Build new undirected adjacency for the coarsened graph
    val newAdj   = scala.collection.mutable.Map[NodeId, scala.collection.mutable.Map[NodeId, Double]]()
    for (((si, sj), w) <- edgeWeights) {
      newAdj.getOrElseUpdate(si, scala.collection.mutable.Map())(sj) = w
      newAdj.getOrElseUpdate(sj, scala.collection.mutable.Map())(si) = w
    }

    val newAdjFinal   = newAdj.map { case (k, m) => k -> m.toMap }.toMap
    val newDegrees    = newAdjFinal.map { case (k, m) => k -> m.values.sum }
    val newTotalWeight = edgeWeights.values.sum

    val coarsened = WeightedFileGraph(
      superVertices,
      newAdjFinal,
      newDegrees.toMap,
      newTotalWeight,
      Map.empty
    )

    (coarsened, newExpansion)
  }
}
