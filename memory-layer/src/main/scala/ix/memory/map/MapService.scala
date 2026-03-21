package ix.memory.map

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.typelevel.log4cats.slf4j.Slf4jLogger

import ix.memory.db.{ArangoClient, GraphQueryApi, GraphWriteApi}
import ix.memory.model._

/**
 * Full pipeline for ix map:
 *   1.  Build weighted file graph
 *   2.  Detect cross-cutting nodes and apply penalty
 *   3.  Run multi-level Louvain clustering
 *   4.  Compute region metrics (cohesion, coupling, boundary ratio)
 *   5.  Infer labels
 *   6.  Score confidence
 *   7.  Persist Region nodes + IN_REGION edges to ArangoDB (top-down: system → subsystem → module → file)
 *   8.  Return ArchitectureMap
 */
class MapService(
  client:   ArangoClient,
  queryApi: GraphQueryApi,
  writeApi: GraphWriteApi
) {

  // Cross-cut penalty multiplier (reduces edge weights involving crosscut files)
  private val CrosscutLambda    = 0.5
  // High-degree threshold: files in the top N% by degree are crosscut candidates
  private val CrosscutDegreeTop = 0.10
  // Path tokens that suggest cross-cutting utilities
  private val CrosscutTokens    = Set(
    "util", "utils", "helper", "helpers", "common", "shared", "base",
    "logging", "log", "logger", "config", "conf", "constants", "constant",
    "extensions", "ext", "mixin", "mixins", "core", "framework"
  )

  private val logger      = Slf4jLogger.getLoggerFromName[IO]("ix.map.service")
  private val builder     = new MapGraphBuilder(client)
  private val fastBuilder = new MapGraphBuilderFast(client)
  private val preflight   = new MapPreflight

  // Persistence guardrail: max total patch ops before we refuse to commit
  private val MaxSafePatchOps = 10000

  // Label kinds by level
  private def labelKind(level: Int, maxLevel: Int): String =
    if (maxLevel <= 1)   "system"
    else if (level == maxLevel) "system"
    else if (level == 1)        "module"
    else                         "subsystem"

  def buildMap(forceFullLocal: Boolean = false): IO[ArchitectureMap] =
    for {
      rev   <- queryApi.getLatestRev
      files <- builder.discoverFiles()
      pf    <- preflight.evaluate(files)
      mode   = if (forceFullLocal) MapExecutionMode.FullLocal else pf.mode
      result <- mode match {
        case MapExecutionMode.FullLocal => buildFullLocal(files, pf, rev, forceFullLocal)
        case MapExecutionMode.FastLocal => buildFastLocal(files, pf, rev)
      }
    } yield result

  private def buildFullLocal(
    files: Vector[FileVertex],
    pf:    MapPreflightResult,
    rev:   Rev,
    bypassPersistenceGuard: Boolean = false
  ): IO[ArchitectureMap] =
    for {
      rawGraph      <- builder.buildGraph(files)
      crosscutScores = detectCrosscut(rawGraph)
      graph          = applyPenalty(rawGraph, crosscutScores)
      levels         = LouvainClustering.cluster(graph, maxLevels = 3, minCommunitySize = 3)
      regions        = buildRegions(graph, levels, crosscutScores, rev)
      pe            <- guardAndPersist(regions, rev, bypassPersistenceGuard)
      _             <- logOutcome(MapOutcome.FullLocalCompleted, pf, pe)
    } yield ArchitectureMap(
      regions, rawGraph.vertices.size, rev.value,
      preflight = Some(pf),
      outcome = MapOutcome.FullLocalCompleted,
      persistenceEstimate = Some(pe)
    )

  private def buildFastLocal(
    files: Vector[FileVertex],
    pf:    MapPreflightResult,
    rev:   Rev
  ): IO[ArchitectureMap] =
    for {
      rawGraph      <- fastBuilder.buildGraph(files)
      crosscutScores = detectCrosscut(rawGraph)
      graph          = applyPenalty(rawGraph, crosscutScores)
      levels         = LouvainClustering.cluster(graph, maxLevels = 3, minCommunitySize = 3)
      regions        = buildRegions(graph, levels, crosscutScores, rev)
      pe            <- guardAndPersist(regions, rev)
      _             <- logOutcome(MapOutcome.FastLocalCompleted, pf, pe)
    } yield ArchitectureMap(
      regions, rawGraph.vertices.size, rev.value,
      preflight = Some(pf),
      outcome = MapOutcome.FastLocalCompleted,
      persistenceEstimate = Some(pe)
    )

  // ── Cross-cutting detection ─────────────────────────────────────────

  private def detectCrosscut(graph: WeightedFileGraph): Map[NodeId, Double] = {
    if (graph.degrees.isEmpty) return Map.empty
    val maxDeg   = graph.degrees.values.max.max(1e-10)
    val threshold = maxDeg * (1.0 - CrosscutDegreeTop)

    graph.vertices.map { v =>
      val deg   = graph.degrees.getOrElse(v.id, 0.0)
      val nameLower = v.path.toLowerCase
      val pathTokens = nameLower.split("[/\\\\._-]").toSet

      val degreeSignal  = if (deg >= threshold) (deg - threshold) / (maxDeg - threshold + 1e-10) else 0.0
      val lexicalSignal = if (pathTokens.intersect(CrosscutTokens).nonEmpty) 0.5 else 0.0

      val score = (0.7 * degreeSignal + 0.3 * lexicalSignal).min(1.0)
      v.id -> score
    }.toMap
  }

  private def applyPenalty(
    graph:  WeightedFileGraph,
    scores: Map[NodeId, Double]
  ): WeightedFileGraph = {
    val newAdj = graph.adjMatrix.map { case (src, neighbors) =>
      val sCross = scores.getOrElse(src, 0.0)
      val adjusted = neighbors.map { case (dst, w) =>
        val dCross  = scores.getOrElse(dst, 0.0)
        val penalty = (sCross + dCross) / 2.0 * CrosscutLambda
        dst -> w * (1.0 - penalty)
      }
      src -> adjusted
    }
    val newDeg   = newAdj.map { case (k, m) => k -> m.values.sum }
    val newTotal = newDeg.values.sum / 2.0
    graph.copy(adjMatrix = newAdj, degrees = newDeg.toMap, totalWeight = newTotal)
  }

  // ── Region construction ─────────────────────────────────────────────

  private def buildRegions(
    graph:          WeightedFileGraph,
    levels:         Vector[LouvainClustering.LevelPartition],
    crosscutScores: Map[NodeId, Double],
    rev:            Rev
  ): Vector[Region] = {
    if (levels.isEmpty) return Vector.empty

    val fileVertexById = graph.vertices.map(v => v.id -> v).toMap
    val maxLevel       = levels.size

    // Compute common absolute-path prefix to strip for label inference
    val allPaths      = graph.vertices.map(_.path)
    val commonPfxLen  = commonPathPrefixLength(allPaths)

    // Build regions for each level, finest first.
    // Apply minCommunitySize at every level — singleton/doubleton regions are noise.
    val minSize = if (maxLevel >= 3) 3 else 2
    val allRegions = levels.zipWithIndex.flatMap { case (partition, levelIdx) =>
      val level = levelIdx + 1
      partition.communities.filter(_.size >= minSize).map { memberFiles =>
        buildOneRegion(
          memberFiles, level, labelKind(level, maxLevel),
          graph, fileVertexById, crosscutScores, rev, commonPfxLen
        )
      }
    }

    // Wire parent/child relationships
    // For each region at level N, find which level-(N+1) region contains its files
    val byLevel: Map[Int, Vector[Region]] =
      allRegions.groupBy(_.level)

    val withParents = allRegions.map { region =>
      val parentOpt = byLevel.get(region.level + 1).flatMap { parents =>
        // Parent must be strictly coarser: strictly larger member set (no equal sets)
        parents
          .filter(p => p.memberFiles.size > region.memberFiles.size &&
                       region.memberFiles.subsetOf(p.memberFiles))
          .minByOption(_.memberFiles.size)    // pick tightest enclosing region
      }
      region.copy(parentId = parentOpt.map(_.id))
    }

    // Fill childRegionIds
    val childrenByParent: Map[NodeId, Set[NodeId]] =
      withParents.flatMap(r => r.parentId.map(pid => pid -> r.id))
        .groupBy(_._1)
        .map { case (k, vs) => k -> vs.map(_._2).toSet }

    val withChildren = withParents.map { r =>
      r.copy(childRegionIds = childrenByParent.getOrElse(r.id, Set.empty))
    }

    // Disambiguate duplicate labels within each level.
    // For each group of same-label regions, find a path segment unique to each.
    val labelGroups = withChildren.groupBy(r => (r.level, r.label))
    val needsDisambig = labelGroups.filter(_._2.size > 1)

    if (needsDisambig.isEmpty) withChildren
    else withChildren.map { r =>
      needsDisambig.get((r.level, r.label)) match {
        case Some(group) =>
          val myPaths    = r.memberFiles.flatMap(id => fileVertexById.get(id).map(_.path)).toSet
          val otherPaths = group.filterNot(_.id == r.id)
            .flatMap(_.memberFiles.flatMap(id => fileVertexById.get(id).map(_.path))).toSet

          // Only use DIRECTORY segments (not filenames) for disambiguation
          def dirSegs(paths: Set[String]): Set[String] =
            paths.flatMap(p => p.split("[/\\\\]").dropRight(1).filterNot(_.isEmpty).map(_.toLowerCase))

          val mySegs    = dirSegs(myPaths)
          val otherSegs = dirSegs(otherPaths)
          val exclusive = (mySegs -- otherSegs).filterNot(LabelNoiseTokens.contains)

          // Prefer shorter tokens (more likely to be a meaningful module name)
          val suffix = exclusive.toVector.sortBy(s => (s.length, s)).headOption
            .map(s => s" / ${s.capitalize}")
            .getOrElse(s" (${r.memberFiles.size}f)")
          r.copy(label = r.label + suffix)
        case None => r
      }
    }
  }

  private val LabelNoiseTokens = Set(
    "main", "scala", "java", "src", "test", "tests", "__tests__", "kotlin",
    "python", "js", "ts", "tsx", "jsx", "com", "org", "io", "net",
    "ix", "memory", "index", "mod", "lib", "pkg", "spec", "dist",
    "app", "application", "impl", "implementation", "internal", "external",
    "ix-memory", "memory-layer", "ix-cli", "core-ingestion", "ix-plugin",
    "projects", "claude"
  )

  private def buildOneRegion(
    memberFiles:    Set[NodeId],
    level:          Int,
    kind:           String,
    graph:          WeightedFileGraph,
    fileVertexById: Map[NodeId, FileVertex],
    crosscutScores: Map[NodeId, Double],
    rev:            Rev,
    commonPfxLen:   Int = 0
  ): Region = {
    // Deterministic ID: stable across re-runs with same file set
    val idKey  = "map:region:" + memberFiles.map(_.value.toString).toList.sorted.mkString(",")
    val nodeId = NodeId(UUID.nameUUIDFromBytes(idKey.getBytes("UTF-8")))

    // Edge weight metrics
    var internalWeight  = 0.0
    var externalWeight  = 0.0
    var boundaryNodes   = Set.empty[NodeId]
    var signalCounts    = Map("calls" -> 0.0, "imports" -> 0.0, "type" -> 0.0)

    for (fileId <- memberFiles) {
      for ((neighbor, w) <- graph.adjMatrix.getOrElse(fileId, Map.empty)) {
        if (memberFiles.contains(neighbor)) {
          internalWeight += w
        } else {
          externalWeight += w
          boundaryNodes  += fileId
        }
      }
    }
    // internalWeight is double-counted (symmetric adj), halve it
    internalWeight /= 2.0

    val n             = memberFiles.size.toDouble.max(1.0)
    val cohesion      = if (n > 1) internalWeight / (n * (n - 1) / 2.0) else 0.0
    // Cap at 100 to avoid floating-point overflow for fully-isolated clusters
    val boundaryRatio = if (externalWeight < 1e-6) math.min(internalWeight / 1e-6, 100.0)
                        else internalWeight / externalWeight

    // Cross-cut score: average of member scores
    val crosscutScore =
      memberFiles.toList.map(f => crosscutScores.getOrElse(f, 0.0)).sum / n

    val label    = inferLabel(memberFiles, fileVertexById, commonPfxLen)
    val confidence = computeConfidence(cohesion, boundaryRatio, memberFiles.size, crosscutScore)

    Region(
      id               = nodeId,
      label            = label,
      labelKind        = kind,
      level            = level,
      memberFiles      = memberFiles,
      childRegionIds   = Set.empty,
      parentId         = None,
      cohesion         = cohesion,
      externalCoupling = externalWeight,
      boundaryRatio    = boundaryRatio,
      confidence       = confidence,
      crosscutScore    = crosscutScore,
      dominantSignals  = List("calls", "imports", "type").sortBy(s => -signalCounts.getOrElse(s, 0.0)),
      interfaceNodeCount = boundaryNodes.size,
      mapRev           = rev.value
    )
  }

  // ── Label inference ─────────────────────────────────────────────────

  /**
   * Infer a human-readable label from file paths in the community.
   *
   * Strategy:
   *   1. Extract all path segments and identifier tokens from filenames.
   *   2. Score each token by frequency within cluster (TF) ×
   *      specificity (higher if not a common Java/Scala package name).
   *   3. Return top token, Title-cased.
   *   Fallback: use the most common non-trivial directory name.
   */
  private def inferLabel(
    memberFiles:    Set[NodeId],
    fileVertexById: Map[NodeId, FileVertex],
    commonPfxLen:   Int = 0
  ): String = {
    val rawPaths = memberFiles.flatMap(f => fileVertexById.get(f).map(_.path)).toVector
    if (rawPaths.isEmpty) return "Unknown"
    // Strip common absolute prefix (e.g. /home/user/project/) so labels are project-relative
    val paths = rawPaths.map { p =>
      val segs = p.split("[/\\\\]")
      if (commonPfxLen > 0 && commonPfxLen < segs.length) segs.drop(commonPfxLen).mkString("/")
      else p
    }

    val noiseTokens = LabelNoiseTokens

    // Strategy 1: Longest common directory suffix across all paths
    val dirSegments = paths.map(p => p.split("[/\\\\]").dropRight(1).toVector)
    val commonDir = longestCommonSuffix(dirSegments)
      .filterNot(s => noiseTokens.contains(s.toLowerCase))
      .headOption

    if (commonDir.isDefined) return commonDir.get.capitalize

    // Strategy 2: Most discriminative non-noise directory segment.
    // Prefer deeper (more specific) segments by scoring: frequency × depth-weight.
    // Split each path into (depth, segment) pairs so we can weight deeper dirs higher.
    val allDirsWithDepth: Vector[(Int, String)] = paths.flatMap { p =>
      val segs = p.split("[/\\\\]").dropRight(1)
      segs.zipWithIndex.map { case (s, i) => (i, s) }
        .filter { case (_, s) => !noiseTokens.contains(s.toLowerCase) && s.nonEmpty }
    }
    // Score: count * (1 + depth / maxDepth) — deeper segments score higher
    val maxDepth = allDirsWithDepth.map(_._1).maxOption.getOrElse(1).toDouble.max(1.0)
    val scored = allDirsWithDepth.groupBy(_._2).map { case (seg, entries) =>
      seg -> entries.length * (1.0 + entries.map(_._1 / maxDepth).sum / entries.length)
    }.toVector.sortBy(-_._2)

    scored.headOption.map(_._1.capitalize).getOrElse {
      // Strategy 3: Most frequent meaningful filename token
      val fileTokens = paths.flatMap { p =>
        val name = p.split("[/\\\\]").lastOption.getOrElse("")
        val noExt = name.replaceAll("\\.[^.]+$", "")
        splitCamel(noExt).filter(t => t.length > 3).map(_.toLowerCase)
      }
      fileTokens.filterNot(noiseTokens.contains)
        .groupBy(identity).maxByOption(_._2.size)
        .map(_._1.capitalize).getOrElse("Region")
    }
  }

  /** Returns the number of leading path segments shared by all paths (the common abs prefix). */
  private def commonPathPrefixLength(paths: Vector[String]): Int = {
    if (paths.size <= 1) return 0
    val split = paths.map(_.split("[/\\\\]").toVector)
    val minLen = split.map(_.length).min
    (0 until minLen).takeWhile(i => split.map(_(i)).distinct.size == 1).length
  }

  /** Returns the longest common suffix of all path segment vectors, innermost first. */
  private def longestCommonSuffix(segLists: Vector[Vector[String]]): Vector[String] = {
    if (segLists.isEmpty || segLists.exists(_.isEmpty)) return Vector.empty
    val reversed = segLists.map(_.reverse)
    val maxLen   = reversed.map(_.length).min
    (0 until maxLen).toVector
      .takeWhile(i => reversed.map(_(i)).distinct.size == 1)
      .map(i => reversed.head(i))
  }

  private def splitCamel(s: String): Array[String] =
    s.split("(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_\\-.]")

  // ── Confidence scoring ──────────────────────────────────────────────

  private def computeConfidence(
    cohesion:     Double,
    boundaryRatio: Double,
    size:         Int,
    crosscutScore: Double
  ): Double = {
    // Normalize boundary ratio: high ratio → high confidence
    val brScore   = math.tanh(boundaryRatio / 3.0)          // saturates around ratio = 6
    val cohScore  = cohesion.min(1.0)
    val sizeBonus = math.tanh(size / 10.0)                  // more files → more signal
    val crossPenalty = crosscutScore * 0.3

    ((0.4 * brScore + 0.3 * cohScore + 0.3 * sizeBonus) - crossPenalty).max(0.0).min(1.0)
  }

  // ── Persistence guardrail + logging ─────────────────────────────────

  private def guardAndPersist(
    regions: Vector[Region],
    rev:     Rev,
    bypassGuard: Boolean = false
  ): IO[PersistenceEstimate] = {
    if (regions.isEmpty) return IO.pure(PersistenceEstimate(0, 0, 0, 0, 0))

    for {
      oldRegions <- queryApi.findNodesByKind(NodeKind.Region, limit = 5000)
      pe          = estimatePersistence(regions, oldRegions.size)
      _          <- logger.debug(
        s"Persistence estimate: ${pe.totalOps} ops " +
        s"(${pe.regionNodes} regions, ${pe.fileEdges} file edges, " +
        s"${pe.regionEdges} region edges, ${pe.deleteOps} deletes)" +
        (if (bypassGuard) " [guard bypassed via --full]" else "")
      )
      _          <- if (!bypassGuard && pe.totalOps > MaxSafePatchOps)
                      IO.raiseError(new MapCapacityException(
                        outcome     = MapOutcome.LocalMapTooLarge,
                        userMessage = "Local map output is too large to persist safely.",
                        next        = "For full system mapping at this scale, use Ix Cloud."
                      ))
                    else if (bypassGuard && pe.totalOps > MaxSafePatchOps)
                      logger.info(
                        s"Persistence guard bypassed (--full): ${pe.totalOps} ops exceeds " +
                        s"limit of $MaxSafePatchOps, continuing anyway"
                      )
                    else IO.unit
      _          <- submitMapPatch(oldRegions, regions, rev)
    } yield pe
  }

  private def estimatePersistence(regions: Vector[Region], oldRegionCount: Int): PersistenceEstimate = {
    val regionNodes = regions.size
    val fileEdges   = regions.filter(_.level == 1).map(_.memberFiles.size).sum
    val regionEdges = regions.count(_.parentId.isDefined)
    val deleteOps   = oldRegionCount
    val totalOps    = deleteOps + regionNodes + fileEdges + regionEdges
    PersistenceEstimate(regionNodes, fileEdges, regionEdges, deleteOps, totalOps)
  }

  private def logOutcome(
    outcome: MapOutcome,
    pf:      MapPreflightResult,
    pe:      PersistenceEstimate
  ): IO[Unit] =
    logger.info(
      s"Map completed: outcome=${outcome.label} " +
      s"mode=${pf.mode.label} risk=${pf.risk.label} " +
      s"files=${pf.cost.fileCount} regions=${pe.regionNodes} " +
      s"patchOps=${pe.totalOps} preflightMs=${pf.durationMs}"
    )

  private def submitMapPatch(oldRegions: Vector[GraphNode], regions: Vector[Region], rev: Rev): IO[Unit] = {
    val deleteOps: Vector[PatchOp] = oldRegions.map(n => PatchOp.DeleteNode(n.id))

    val nodeOps: Vector[PatchOp] = regions.map { r =>
      PatchOp.UpsertNode(
        id   = r.id,
        kind = NodeKind.Region,
        name = r.label,
        attrs = Map(
          "map_generated"      -> Json.True,
          "level"              -> r.level.asJson,
          "label_kind"         -> r.labelKind.asJson,
          "file_count"         -> r.memberFiles.size.asJson,
          "member_files"       -> r.memberFiles.map(_.value.toString).asJson,
          "cohesion"           -> r.cohesion.asJson,
          "external_coupling"  -> r.externalCoupling.asJson,
          "boundary_ratio"     -> r.boundaryRatio.asJson,
          "confidence"         -> r.confidence.asJson,
          "crosscut_score"     -> r.crosscutScore.asJson,
          "dominant_signals"   -> r.dominantSignals.asJson,
          "interface_node_count" -> r.interfaceNodeCount.asJson,
          "map_rev"            -> r.mapRev.asJson
        )
      )
    }

    // IN_REGION edges: region → file (level-1 regions only, top-down)
    val fileEdgeOps: Vector[PatchOp] = regions
      .filter(_.level == 1)
      .flatMap { r =>
        r.memberFiles.toVector.map { fileId =>
          val edgeId = EdgeId(
            UUID.nameUUIDFromBytes(s"in_region:${r.id.value}:${fileId.value}".getBytes("UTF-8"))
          )
          PatchOp.UpsertEdge(
            id        = edgeId,
            src       = r.id,
            dst       = fileId,
            predicate = EdgePredicate("IN_REGION"),
            attrs     = Map.empty
          )
        }
      }

    // IN_REGION edges: parent region → child region (top-down)
    val regionEdgeOps: Vector[PatchOp] = regions.flatMap { r =>
      r.parentId.map { pid =>
        val edgeId = EdgeId(
          UUID.nameUUIDFromBytes(s"in_region:${pid.value}:${r.id.value}".getBytes("UTF-8"))
        )
        PatchOp.UpsertEdge(
          id        = edgeId,
          src       = pid,
          dst       = r.id,
          predicate = EdgePredicate("IN_REGION"),
          attrs     = Map.empty
        )
      }
    }

    val allOps = deleteOps ++ nodeOps ++ fileEdgeOps ++ regionEdgeOps
    val patch  = GraphPatch(
      patchId   = PatchId(UUID.nameUUIDFromBytes(s"map:${rev.value}".getBytes("UTF-8"))),
      actor     = "map-service",
      timestamp = Instant.now(),
      source    = PatchSource("ix:map", None, "map-service", SourceType.Inferred),
      baseRev   = rev,
      ops       = allOps,
      replaces  = Vector.empty,
      intent    = Some(s"Architectural map computed at rev ${rev.value}")
    )

    writeApi.commitPatch(patch).void
  }
}
