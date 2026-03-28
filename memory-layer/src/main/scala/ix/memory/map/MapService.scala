package ix.memory.map

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.parallel._
import com.fasterxml.jackson.databind.ObjectMapper
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
  private val mapper = new ObjectMapper()
  private val logger = Slf4jLogger.getLoggerFromName[IO]("ix.map")
  private val CrosscutThreshold = 0.10

  // Cross-cut penalty multiplier (reduces edge weights involving crosscut files)
  private val CrosscutLambda    = 0.5
  // High-degree threshold: files in the top N% by degree are crosscut candidates
  private val CrosscutDegreeTop = 0.10
  // Path tokens that suggest cross-cutting utilities
  private val CrosscutTokens    = Set(
    "util", "utils", "helper", "helpers", "common", "shared", "base",
    "logging", "log", "logger", "config", "conf", "constants", "constant",
    "extensions", "ext"
  )
  private val SignalWeights = Map(
    "CALLS"      -> 1.0,
    "IMPORTS"    -> 0.5,
    "EXTENDS"    -> 1.2,
    "IMPLEMENTS" -> 1.2,
    "PATH"       -> 0.2
  )

  private val fullBuilder = new MapGraphBuilder(client)
  private val preflight = new MapPreflight()
  private final class RetainedRegion(val level: Int, val communityIndex: Int, val region: Region)

  // Label kinds by level
  private def labelKind(level: Int, maxLevel: Int): String =
    if (maxLevel <= 1)   "system"
    else if (level == maxLevel) "system"
    else if (level == 1)        "module"
    else                         "subsystem"

  def buildMap(forceRecompute: Boolean = false, forceFull: Boolean = false): IO[ArchitectureMap] =
    getOrBuildMap(forceRecompute, forceFull)

  def getOrBuildMap(forceRecompute: Boolean = false, forceFull: Boolean = false): IO[ArchitectureMap] =
    for {
      inputRev <- fullBuilder.currentInputRev()
      cached   <- loadCachedMap(inputRev)
      archMap  <- if (cached.nonEmpty && !forceRecompute) IO.pure(cached.get)
                  else computeAndPersistMap(inputRev, cached, forceFull)
    } yield archMap

  def loadPersistedMapForCurrentGraph(): IO[Option[ArchitectureMap]] =
    for {
      inputRev <- fullBuilder.currentInputRev()
      cached   <- loadCachedMap(inputRev)
    } yield cached

  def loadCachedMap(): IO[Option[ArchitectureMap]] =
    loadPersistedMapForCurrentGraph()

  def resolveRegion(map: ArchitectureMap, target: String): Vector[RegionMatch] = {
    val query = target.trim
    val normalizedQuery = normalizeLabelQuery(query)
    if (query.isEmpty || normalizedQuery.isEmpty) Vector.empty
    else {
      map.regions.flatMap { region =>
        matchQuality(region.label, query).map { quality =>
          RegionMatch(region, quality, normalizeLabelQuery(region.label))
        }
      }.sortBy { m =>
        (
          m.matchQuality,
          levelPreference(m.region),
          -m.region.memberFiles.size,
          -m.region.confidence,
          m.normalizedLabel,
          m.region.id.value.toString
        )
      }
    }
  }

  def childrenOf(map: ArchitectureMap, region: Region): Vector[Region] = {
    val regionById = map.regions.map(r => r.id -> r).toMap
    val directChildren = region.childRegionIds.toVector
      .flatMap(regionById.get)
      .filter(_.level < region.level)

    val children =
      if (directChildren.nonEmpty) directChildren
      else map.regions.filter(_.parentId.contains(region.id))

    sortBySignificance(children.distinct)
  }

  def parentOf(map: ArchitectureMap, region: Region): Option[Region] = {
    val regionById = map.regions.map(r => r.id -> r).toMap
    region.parentId.flatMap(regionById.get)
  }

  def subtreeOf(map: ArchitectureMap, region: Region): Vector[Region] = {
    def loop(current: Region): Vector[Region] = {
      val directChildren = childrenOf(map, current)
      current +: directChildren.flatMap(loop)
    }
    loop(region)
  }

  def scopedView(map: ArchitectureMap, region: Region): ScopedSubsystemView = {
    val scopeRegions =
      if (region.labelKind == "module") Vector(region)
      else subtreeOf(map, region)

    val summary = ScopedHealthSummary(
      wellDefined  = scopeRegions.count(_.confidence >= 0.75),
      moderate     = scopeRegions.count(r => r.confidence >= 0.50 && r.confidence < 0.75),
      fuzzy        = scopeRegions.count(_.confidence < 0.50),
      crossCutting = scopeRegions.count(isCrossCutting)
    )

    ScopedSubsystemView(
      target   = region,
      parent   = parentOf(map, region),
      children = if (region.labelKind == "module") Vector.empty else childrenOf(map, region),
      subtree  = scopeRegions,
      summary  = summary
    )
  }

  def isCrossCutting(region: Region): Boolean =
    region.crosscutScore > CrosscutThreshold

  // ── Cross-cutting detection ─────────────────────────────────────────

  private def detectCrosscut(graph: WeightedFileGraph): Map[NodeId, Double] = {
    if (graph.degrees.isEmpty) return Map.empty
    val maxDeg   = graph.degrees.values.max.max(1e-10)
    val threshold = highDegreeThreshold(graph)

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

  private def highDegreeThreshold(graph: WeightedFileGraph): Double = {
    val sortedDegrees = graph.degrees.values.toVector.sorted
    if (sortedDegrees.isEmpty) 0.0
    else {
      val cutoffIndex = math.ceil(sortedDegrees.size * (1.0 - CrosscutDegreeTop)).toInt - 1
      val clamped = cutoffIndex.max(0).min(sortedDegrees.size - 1)
      sortedDegrees(clamped)
    }
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
    val relativePaths = allPaths.map(path => relativizePath(path, commonPfxLen))
    val globalDirTokenCounts = directoryTokenCounts(relativePaths)
    val signalAdjacency = buildSignalAdjacency(graph)

    // Build regions for each level, finest first.
    // Apply minCommunitySize at every level — singleton/doubleton regions are noise.
    val minSize = if (maxLevel >= 3) 3 else 2
    val retainedRegions = levels.zipWithIndex.flatMap { case (partition, levelIdx) =>
      val level = levelIdx + 1
      partition.communities.zipWithIndex.collect {
        case (memberFiles, communityIndex) if memberFiles.size >= minSize =>
          new RetainedRegion(
            level = level,
            communityIndex = communityIndex,
            region = buildOneRegion(
          memberFiles, level, labelKind(level, maxLevel),
          graph, fileVertexById, crosscutScores, signalAdjacency, rev, commonPfxLen, globalDirTokenCounts
            )
          )
      }
    }
    val retainedByLevel = retainedRegions.groupBy(_.level)
      .view
      .mapValues(_.map(retained => retained.communityIndex -> retained.region).toMap)
      .toMap

    // Wire parent/child relationships
    val withParents = retainedRegions.map { retained =>
      val parentOpt = levels.lift(retained.level).flatMap { coarseLevel =>
        val candidateCommunities = retained.region.memberFiles.iterator
          .flatMap(fileId => coarseLevel.assignment.get(fileId))
          .toSet
        if (candidateCommunities.size != 1) None
        else {
          retainedByLevel.get(retained.level + 1)
            .flatMap(_.get(candidateCommunities.head))
            .filter(_.memberFiles.size > retained.region.memberFiles.size)
        }
      }
      retained.region.copy(parentId = parentOpt.map(_.id))
    }

    // Fill childRegionIds
    val childrenByParent: Map[NodeId, Set[NodeId]] =
      withParents.flatMap(r => r.parentId.map(pid => pid -> r.id))
        .groupBy(_._1)
        .map { case (k, vs) => k -> vs.map(_._2).toSet }

    val withChildren = withParents.map { r =>
      r.copy(childRegionIds = childrenByParent.getOrElse(r.id, Set.empty))
    }
    val dedupedHierarchy = collapseDuplicateHierarchyLevels(withChildren)

    // Disambiguate duplicate labels within each level.
    // For each group of same-label regions, find a path segment unique to each.
    val labelGroups = dedupedHierarchy.groupBy(r => (r.level, r.label))
    val needsDisambig = labelGroups.filter(_._2.size > 1)

    if (needsDisambig.isEmpty) dedupedHierarchy
    else dedupedHierarchy.map { r =>
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

          // Prefer shorter tokens (more likely to be a meaningful module name).
          // Fallback: rank by size — largest keeps the clean label, smaller ones get "(2)", "(3)", etc.
          val suffix = exclusive.toVector.sortBy(s => (s.length, s)).headOption
            .map(s => s" / ${s.capitalize}")
            .getOrElse {
              val rank = group.sortBy(-_.memberFiles.size).indexWhere(_.id == r.id) + 1
              if (rank <= 1) "" else s" ($rank)"
            }
          r.copy(label = r.label + suffix)
        case None => r
      }
    }
  }

  private[map] def collapseDuplicateHierarchyLevels(regions: Vector[Region]): Vector[Region] = {
    val keepById = regions.groupBy(_.id).view.mapValues { duplicates =>
      duplicates.maxBy(region => (region.level, region.confidence, region.label.length))
    }.toMap

    regions.filter(region => keepById.get(region.id).contains(region))
  }

  private val LabelNoiseTokens = Set(
    "main", "scala", "java", "src", "test", "tests", "__tests__", "kotlin",
    "python", "js", "ts", "tsx", "jsx", "com", "org", "io", "net",
    "ix", "memory", "index", "mod", "lib", "pkg", "spec", "dist",
    "app", "application", "impl", "implementation", "internal", "external",
    "ix-memory", "memory-layer", "ix-cli", "core-ingestion", "ix-plugin",
    "projects", "claude"
  )
  private val WeakLabelTokens = Set(
    "api", "apis", "service", "services", "controller", "controllers",
    "repository", "repositories", "handler", "handlers", "module", "modules",
    "common", "shared", "core", "base", "internal", "external", "model",
    "models", "entity", "entities", "dto", "dtos", "types", "errors",
    "interface", "interfaces"
  )

  private def buildOneRegion(
    memberFiles:    Set[NodeId],
    level:          Int,
    kind:           String,
    graph:          WeightedFileGraph,
    fileVertexById: Map[NodeId, FileVertex],
    crosscutScores: Map[NodeId, Double],
    signalAdjacency: Map[NodeId, Vector[(NodeId, Map[String, Int])]],
    rev:            Rev,
    commonPfxLen:   Int = 0,
    globalDirTokenCounts: Map[String, Int] = Map.empty
  ): Region = {
    // Deterministic ID: stable across re-runs with same file set
    val idKey  = "map:region:" + memberFiles.map(_.value.toString).toList.sorted.mkString(",")
    val nodeId = NodeId(UUID.nameUUIDFromBytes(idKey.getBytes("UTF-8")))

    // Edge weight metrics
    var internalWeight  = 0.0
    var externalWeight  = 0.0
    var boundaryNodes   = Set.empty[NodeId]

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

    val label    = inferLabel(memberFiles, fileVertexById, commonPfxLen, globalDirTokenCounts)
    val confidence = computeConfidence(cohesion, boundaryRatio, memberFiles.size, crosscutScore)
    val dominantSignals = computeDominantSignals(memberFiles, signalAdjacency)

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
      dominantSignals  = dominantSignals,
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
    commonPfxLen:   Int = 0,
    globalDirTokenCounts: Map[String, Int] = Map.empty
  ): String = {
    val rawPaths = memberFiles.flatMap(f => fileVertexById.get(f).map(_.path)).toVector
    if (rawPaths.isEmpty) return "Unknown"
    val paths = rawPaths.map(path => relativizePath(path, commonPfxLen))

    val noiseTokens = LabelNoiseTokens

    val suffixLabel = longestCommonSuffix(paths.map(path => directorySegments(path).toVector))
      .iterator
      .map(_.toLowerCase)
      .find(token => token.nonEmpty && !noiseTokens.contains(token))

    suffixLabel match {
      case Some(token) if !WeakLabelTokens.contains(token) =>
        humanizeLabel(token)
      case _ =>
        bestDiscriminativeDirectoryToken(paths, globalDirTokenCounts)
          .orElse(bestFilenameToken(paths))
          .map(humanizeLabel)
          .getOrElse("Region")
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

  private def relativizePath(path: String, commonPfxLen: Int): String = {
    val segs = path.split("[/\\\\]")
    if (commonPfxLen > 0 && commonPfxLen < segs.length) segs.drop(commonPfxLen).mkString("/")
    else path
  }

  private def directorySegments(path: String): Vector[String] =
    path.split("[/\\\\]").dropRight(1).toVector

  private def directoryTokenCounts(paths: Vector[String]): Map[String, Int] =
    paths.flatMap(directorySegments)
      .map(_.toLowerCase)
      .filter(token => token.nonEmpty && !LabelNoiseTokens.contains(token))
      .groupBy(identity)
      .map { case (token, entries) => token -> entries.size }

  private def bestDiscriminativeDirectoryToken(
    paths: Vector[String],
    globalDirTokenCounts: Map[String, Int]
  ): Option[String] = {
    val clusterCounts = directoryTokenCounts(paths)
    clusterCounts.toVector
      .map { case (token, intraCount) =>
        val globalCount = globalDirTokenCounts.getOrElse(token, intraCount).max(intraCount)
        val score = intraCount.toDouble * (intraCount.toDouble / globalCount.toDouble)
        (token, score, intraCount, globalCount)
      }
      .sortBy { case (token, score, intraCount, globalCount) =>
        (-score, globalCount, -intraCount, token)
      }
      .headOption
      .map(_._1)
  }

  private def bestFilenameToken(paths: Vector[String]): Option[String] = {
    val fileTokens = paths.flatMap { p =>
      val name = p.split("[/\\\\]").lastOption.getOrElse("")
      val noExt = name.replaceAll("\\.[^.]+$", "")
      splitCamel(noExt)
        .map(_.toLowerCase)
        .filter(token => token.length > 3 && !LabelNoiseTokens.contains(token))
    }

    fileTokens.groupBy(identity)
      .toVector
      .sortBy { case (token, entries) => (-entries.size, token) }
      .headOption
      .map(_._1)
  }

  private def humanizeLabel(token: String): String =
    token.split("[-_\\s]+").filter(_.nonEmpty).map(_.capitalize).mkString(" ")

  private def normalizeWhitespace(input: String): String =
    input.trim.toLowerCase.replaceAll("\\s+", " ")

  private def normalizeLabelQuery(input: String): String =
    normalizeWhitespace(input.replaceAll("[/_-]+", " "))

  private def matchQuality(label: String, query: String): Option[Int] = {
    val trimmedLabel = label.trim
    val trimmedQuery = query.trim
    val whitespaceLabel = normalizeWhitespace(trimmedLabel)
    val whitespaceQuery = normalizeWhitespace(trimmedQuery)
    val normalizedLabel = normalizeLabelQuery(trimmedLabel)
    val normalizedQuery = normalizeLabelQuery(trimmedQuery)

    if (trimmedLabel.equalsIgnoreCase(trimmedQuery)) Some(0)
    else if (whitespaceLabel == whitespaceQuery) Some(1)
    else if (normalizedLabel == normalizedQuery) Some(2)
    else if (normalizedLabel.startsWith(normalizedQuery)) Some(3)
    else if (normalizedLabel.contains(normalizedQuery)) Some(4)
    else None
  }

  private def levelPreference(region: Region): Int =
    region.labelKind match {
      case "subsystem" => 0
      case "module"    => 1
      case "system"    => 2
      case _           => 3
    }

  private def sortBySignificance(regions: Seq[Region]): Vector[Region] =
    regions.toVector.sortBy(r => (-r.memberFiles.size, -r.confidence, r.label.toLowerCase, r.id.value.toString))

  private def buildSignalAdjacency(
    graph: WeightedFileGraph
  ): Map[NodeId, Vector[(NodeId, Map[String, Int])]] = {
    val adjacency = scala.collection.mutable.Map.empty[NodeId, Vector[(NodeId, Map[String, Int])]]
    for (((src, dst), predicateCounts) <- graph.predicatePairs) {
      adjacency.update(src, adjacency.getOrElse(src, Vector.empty) :+ (dst -> predicateCounts))
      adjacency.update(dst, adjacency.getOrElse(dst, Vector.empty) :+ (src -> predicateCounts))
    }
    adjacency.toMap
  }

  private def computeDominantSignals(
    memberFiles: Set[NodeId],
    signalAdjacency: Map[NodeId, Vector[(NodeId, Map[String, Int])]]
  ): List[String] = {
    val signalScores = scala.collection.mutable.Map(
      "calls" -> 0.0,
      "imports" -> 0.0,
      "type" -> 0.0,
      "path" -> 0.0
    ).withDefaultValue(0.0)

    for {
      src <- memberFiles.iterator
      (dst, predicateCounts) <- signalAdjacency.getOrElse(src, Vector.empty)
      if memberFiles.contains(dst)
      if src.value.compareTo(dst.value) < 0
      (predicate, count) <- predicateCounts
      if count > 0
    } {
      predicate match {
        case "CALLS" =>
          signalScores("calls") += SignalWeights("CALLS") * math.log1p(count.toDouble)
        case "IMPORTS" =>
          signalScores("imports") += SignalWeights("IMPORTS") * math.log1p(count.toDouble)
        case "EXTENDS" | "IMPLEMENTS" =>
          signalScores("type") += SignalWeights(predicate) * math.log1p(count.toDouble)
        case "PATH" =>
          signalScores("path") += SignalWeights("PATH") * count.toDouble
        case _ =>
      }
    }

    val ranked = signalScores.toVector
      .filter(_._2 > 0.0)
      .sortBy { case (name, score) => (-score, name) }
      .map(_._1)
      .take(3)
      .toList

    if (ranked.nonEmpty) ranked else List("path")
  }

  private def canonicalRegionPair(a: NodeId, b: NodeId): (NodeId, NodeId) =
    if (a.value.toString <= b.value.toString) (a, b) else (b, a)

  private def signalCategory(predicate: String): String =
    predicate match {
      case "CALLS"                 => "calls"
      case "IMPORTS"               => "imports"
      case "EXTENDS" | "IMPLEMENTS" => "type"
      case "PATH"                  => "path"
      case other                   => other.toLowerCase
    }

  // ── Architecture edge computation ──────────────────────────────────

  private def computeArchitectureEdges(
    regions: Vector[Region],
    graph:   WeightedFileGraph
  ): Vector[ArchitectureEdge] = {
    if (regions.isEmpty || graph.predicatePairs.isEmpty) return Vector.empty

    def buildEdge(
      idSeed: String,
      src: NodeId,
      dst: NodeId,
      level: Int,
      predicateCounts: Map[String, Int]
    ): Option[ArchitectureEdge] = {
      val signalScores = predicateCounts.toVector
        .map { case (predicate, count) =>
          signalCategory(predicate) -> (SignalWeights.getOrElse(predicate, 0.0) * math.log1p(count.toDouble))
        }
        .groupBy(_._1)
        .view
        .mapValues(_.map(_._2).sum)
        .toMap

      val weight = signalScores.values.sum
      if (weight <= 0.0) None
      else {
        val dominantSignal = signalScores.toVector
          .sortBy { case (signal, score) => (-score, signal) }
          .headOption
          .map(_._1)
          .getOrElse("path")

        Some(ArchitectureEdge(
          id = UUID.nameUUIDFromBytes(idSeed.getBytes("UTF-8")).toString,
          src = src,
          dst = dst,
          level = level,
          weight = weight,
          dominantSignal = dominantSignal,
          predicateCounts = predicateCounts
        ))
      }
    }

    // File-level edges (level 0)
    val fileEdges = graph.predicatePairs.toVector.flatMap { case ((src, dst), predicateCounts) =>
      buildEdge(
        idSeed = s"map:file-edge:${src.value}:${dst.value}",
        src = src,
        dst = dst,
        level = 0,
        predicateCounts = predicateCounts.filter(_._2 > 0)
      )
    }

    // Region-level edges: aggregate file pairs into region pairs per level
    val fileToRegionByLevel: Map[Int, Map[NodeId, Region]] = regions.groupBy(_.level).view.mapValues { levelRegions =>
      levelRegions.toVector.flatMap(region =>
        region.memberFiles.toVector.map(fileId => fileId -> region)
      ).toMap
    }.toMap

    val aggregated = scala.collection.mutable.Map.empty[(Int, NodeId, NodeId), scala.collection.mutable.Map[String, Int]]

    for {
      ((srcFile, dstFile), predicateCounts) <- graph.predicatePairs
      (level, byFile) <- fileToRegionByLevel
      srcRegion <- byFile.get(srcFile)
      dstRegion <- byFile.get(dstFile)
      if srcRegion.id != dstRegion.id
    } {
      val (srcRegionId, dstRegionId) = canonicalRegionPair(srcRegion.id, dstRegion.id)
      val bucket = aggregated.getOrElseUpdate(
        (level, srcRegionId, dstRegionId),
        scala.collection.mutable.Map.empty[String, Int]
      )
      predicateCounts.foreach { case (predicate, count) =>
        bucket.update(predicate, bucket.getOrElse(predicate, 0) + count)
      }
    }

    val regionEdges = aggregated.toVector.flatMap { case ((level, src, dst), predicateCountsMut) =>
      val predicateCounts = predicateCountsMut.toMap.filter(_._2 > 0)
      buildEdge(
        idSeed = s"map:region-edge:$level:${src.value}:${dst.value}",
        src = src,
        dst = dst,
        level = level,
        predicateCounts = predicateCounts
      )
    }

    (regionEdges ++ fileEdges).sortBy(edge => (edge.level, edge.src.value.toString, edge.dst.value.toString))
  }

  // ── Confidence scoring ──────────────────────────────────────────────

  private def computeConfidence(
    cohesion:     Double,
    boundaryRatio: Double,
    size:         Int,
    crosscutScore: Double
  ): Double = {
    val brScore   = math.tanh(boundaryRatio / 2.5)
    val cohScore  = cohesion.min(1.0)
    val sizeBonus = math.tanh(size / 8.0)
    val crossPenalty = crosscutScore * 0.4

    ((0.4 * brScore + 0.3 * cohScore + 0.3 * sizeBonus) - crossPenalty).max(0.0).min(1.0)
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private def computeAndPersistMap(
    inputRev: Rev,
    cached: Option[ArchitectureMap],
    forceFull: Boolean
  ): IO[ArchitectureMap] =
    for {
      files          <- fullBuilder.discoverFiles()
      preflightEval  <- preflight.evaluate(files)
      t0             <- IO(System.currentTimeMillis())
      rawGraph       <- fullBuilder.buildGraph(files)
      t1             <- IO(System.currentTimeMillis())
      crosscutScores <- IO.blocking(detectCrosscut(rawGraph))
      graph          <- IO.blocking(applyPenalty(rawGraph, crosscutScores))
      t2             <- IO(System.currentTimeMillis())
      levels         <- IO.blocking(LouvainClustering.cluster(graph, maxLevels = 3, minCommunitySize = 3))
      t3             <- IO(System.currentTimeMillis())
      regions        <- IO.blocking(buildRegions(graph, levels, crosscutScores, inputRev))
      edges          <- IO.blocking(computeArchitectureEdges(regions, rawGraph))
      fresh           = ArchitectureMap(
                          regions = regions,
                          edges = edges,
                          fileCount = rawGraph.vertices.size,
                          mapRev = inputRev.value,
                          preflight = Some(preflightEval),
                          outcome = MapOutcome.FullLocalCompleted
                        )
      t4             <- IO(System.currentTimeMillis())
      _              <- persistMap(fresh, cached)
      t5             <- IO(System.currentTimeMillis())
      _              <- logger.info(
                          s"map mode=${fresh.outcome.label} files=${files.size} build=${t1-t0}ms crosscut=${t2-t1}ms cluster=${t3-t2}ms regions=${t4-t3}ms persist=${t5-t4}ms total=${t5-t0}ms"
                        )
    } yield fresh

  private def loadCachedMap(inputRev: Rev): IO[Option[ArchitectureMap]] =
    for {
      rows <- client.query(
        """FOR n IN nodes
          |  FILTER n.kind == "region"
          |    AND n.deleted_rev == null
          |    AND n.attrs.map_generated == true
          |    AND TO_NUMBER(n.attrs.map_rev) == @mapRev
          |  SORT TO_NUMBER(n.attrs.level) DESC, n.name ASC
          |  RETURN {
          |    id: n.logical_id,
          |    name: n.name,
          |    attrs: n.attrs
          |  }""".stripMargin,
        Map("mapRev" -> Long.box(inputRev.value).asInstanceOf[AnyRef])
      )
      decoded = rows.flatMap(decodePersistedRegion(_, inputRev)).toVector
      regions  = rehydrateRelationships(decoded)
      fcAndGraph <- if (regions.isEmpty) IO.pure((0, None))
                    else (
                      fullBuilder.liveFileCount(),
                      fullBuilder.discoverFiles().flatMap(fullBuilder.buildGraph).map(Some(_))
                    ).parTupled
      (fileCount, rawGraphOpt) = fcAndGraph
      edges = rawGraphOpt.map(g => computeArchitectureEdges(regions, g)).getOrElse(Vector.empty)
    } yield {
      if (regions.isEmpty) None
      else Some(ArchitectureMap(regions, edges, fileCount, inputRev.value))
    }

  private def decodePersistedRegion(json: Json, inputRev: Rev): Option[Region] = {
    val c      = json.hcursor
    val attrs  = c.downField("attrs")

    for {
      idStr     <- c.get[String]("id").toOption
      label     <- c.get[String]("name").toOption
      id        <- parseNodeId(idStr)
      level     <- attrs.get[Int]("level").toOption
      labelKind <- attrs.get[String]("label_kind").toOption
    } yield {
      val memberFiles = attrs.get[Vector[String]]("member_files").getOrElse(Vector.empty).flatMap(parseNodeId).toSet
      val childIds    = attrs.get[Vector[String]]("child_region_ids").getOrElse(Vector.empty).flatMap(parseNodeId).toSet
      val parentId    = attrs.get[Option[String]]("parent_id").getOrElse(None).flatMap(parseNodeId)

      Region(
        id                 = id,
        label              = label,
        labelKind          = labelKind,
        level              = level,
        memberFiles        = memberFiles,
        childRegionIds     = childIds,
        parentId           = parentId,
        cohesion           = attrs.get[Double]("cohesion").getOrElse(0.0),
        externalCoupling   = attrs.get[Double]("external_coupling").getOrElse(0.0),
        boundaryRatio      = attrs.get[Double]("boundary_ratio").getOrElse(0.0),
        confidence         = attrs.get[Double]("confidence").getOrElse(0.0),
        crosscutScore      = attrs.get[Double]("crosscut_score").getOrElse(0.0),
        dominantSignals    = attrs.get[List[String]]("dominant_signals").getOrElse(Nil),
        interfaceNodeCount = attrs.get[Int]("interface_node_count").getOrElse(0),
        mapRev             = attrs.get[Long]("map_rev").getOrElse(inputRev.value)
      )
    }
  }

  private def parseNodeId(id: String): Option[NodeId] =
    scala.util.Try(UUID.fromString(id)).toOption.map(NodeId(_))

  private def rehydrateRelationships(regions: Vector[Region]): Vector[Region] = {
    if (regions.isEmpty) return regions

    val parentByChild = regions.iterator
      .flatMap(region => region.childRegionIds.iterator.map(childId => childId -> region.id))
      .toMap

    val childrenByParent = regions
      .flatMap(region => region.parentId.map(parentId => parentId -> region.id))
      .groupBy(_._1)
      .view
      .mapValues(_.map(_._2).toSet)
      .toMap

    regions.map { region =>
      val parentId = region.parentId.orElse(parentByChild.get(region.id))
      val childIds =
        if (region.childRegionIds.nonEmpty) region.childRegionIds
        else childrenByParent.getOrElse(region.id, Set.empty)
      region.copy(parentId = parentId, childRegionIds = childIds)
    }
  }

  private def persistMap(fresh: ArchitectureMap, cached: Option[ArchitectureMap]): IO[Unit] = {
    if (cached.exists(existing => sameRegions(existing.regions, fresh.regions))) IO.unit
    else {
      for {
        oldLogicalIds <- loadOldRegionIds()
        _             <- submitMapPatch(oldLogicalIds, fresh.regions, Rev(fresh.mapRev))
      } yield ()
    }
  }

  private def sameRegions(left: Vector[Region], right: Vector[Region]): Boolean =
    left.sortBy(_.id.value.toString) == right.sortBy(_.id.value.toString)

  /** Fetch only the logical_ids of current live region nodes — cheaper than full GraphNode. */
  private def loadOldRegionIds(): IO[Vector[String]] =
    client.query(
      """FOR n IN nodes
        |  FILTER n.kind == "region"
        |    AND n.deleted_rev == null
        |  LIMIT 5000
        |  RETURN n.logical_id""".stripMargin,
      Map.empty
    ).map(_.flatMap(_.as[String].toOption).toVector)

  /**
   * Persist map regions using direct bulk operations instead of the per-op transaction path.
   *
   * This replaces the old commitPatch approach (which made N+1 DB round-trips inside
   * a transaction, causing timeouts on large repos) with five bulk operations:
   *   1. Batch AQL tombstone for old region nodes
   *   2. Batch AQL tombstone for old region edges
   *   3. bulkInsert for new region nodes
   *   4. bulkInsertEdges for IN_REGION edges
   *   5. Revision update
   */
  private def submitMapPatch(
    oldRegionIds: Vector[String],
    regions:      Vector[Region],
    rev:          Rev
  ): IO[Unit] = {
    if (oldRegionIds.isEmpty && regions.isEmpty) return IO.unit

    val now = Instant.now().toString
    val provMap = {
      val m = new java.util.HashMap[String, AnyRef]()
      m.put("source_uri",  "ix:map")
      m.put("source_hash", null)
      m.put("extractor",   "map-service")
      m.put("source_type", "inferred")
      m.put("observed_at", now)
      m
    }

    for {
      latestRev <- queryApi.getLatestRev
      newRev     = latestRev.value + 1L

      // 1. Tombstone old region nodes
      _ <- if (oldRegionIds.isEmpty) IO.unit
           else {
             val ids = new java.util.ArrayList[String]()
             oldRegionIds.foreach(ids.add)
             client.execute(
               """FOR n IN nodes
                 |  FILTER n.logical_id IN @ids AND n.deleted_rev == null
                 |  UPDATE n WITH { deleted_rev: @rev, updated_at: @now } IN nodes""".stripMargin,
               Map(
                 "ids" -> ids.asInstanceOf[AnyRef],
                 "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
                 "now" -> now.asInstanceOf[AnyRef]
               )
             )
           }

      // 2. Tombstone all active IN_REGION edges in one indexed query.
      //    Replaces the old loadActiveRegionEdgeIds approach (which did a full
      //    collection scan with a large src/dst IN clause — the main freeze point).
      _ <- client.execute(
             """FOR e IN edges
               |  FILTER e.predicate == "IN_REGION"
               |    AND e.deleted_rev == null
               |  UPDATE e WITH { deleted_rev: @rev, updated_at: @now } IN edges""".stripMargin,
             Map(
               "rev" -> Long.box(newRev).asInstanceOf[AnyRef],
               "now" -> now.asInstanceOf[AnyRef]
             )
           )

      // 3. Bulk-insert new region nodes
      nodeDocs = regions.map(r => buildRegionNodeDoc(r, newRev, now, provMap))
      _ <- if (nodeDocs.isEmpty) IO.unit
           else client.bulkInsert("nodes", nodeDocs).void

      // 4. Bulk-insert IN_REGION edges
      edgeDocs = buildRegionEdgeDocs(regions, newRev, now, provMap)
      _ <- if (edgeDocs.isEmpty) IO.unit
           else client.bulkInsertEdges("edges", edgeDocs).void

      // 5. Update current revision
      _ <- client.execute(
             """UPSERT { _key: "current" }
               |  INSERT { _key: "current", rev: @rev }
               |  UPDATE { rev: @rev }
               |  IN revisions""".stripMargin,
             Map("rev" -> Long.box(newRev).asInstanceOf[AnyRef])
           )
    } yield ()
  }

  private def buildRegionNodeDoc(
    r:        Region,
    newRev:   Long,
    now:      String,
    provMap:  java.util.Map[String, AnyRef]
  ): java.util.Map[String, AnyRef] = {
    val logicalId = r.id.value.toString
    val attrsJson = Json.obj(
      "label"                -> r.label.asJson,
      "map_generated"        -> Json.True,
      "level"                -> r.level.asJson,
      "label_kind"           -> r.labelKind.asJson,
      "file_count"           -> r.memberFiles.size.asJson,
      "member_files"         -> r.memberFiles.map(_.value.toString).asJson,
      "parent_id"            -> r.parentId.map(_.value.toString).asJson,
      "child_region_ids"     -> r.childRegionIds.toVector.map(_.value.toString).sorted.asJson,
      "cohesion"             -> r.cohesion.asJson,
      "external_coupling"    -> r.externalCoupling.asJson,
      "boundary_ratio"       -> r.boundaryRatio.asJson,
      "confidence"           -> r.confidence.asJson,
      "crosscut_score"       -> r.crosscutScore.asJson,
      "dominant_signals"     -> r.dominantSignals.asJson,
      "interface_node_count" -> r.interfaceNodeCount.asJson,
      "map_rev"              -> r.mapRev.asJson
    ).noSpaces
    val doc = new java.util.HashMap[String, AnyRef]()
    doc.put("_key",        s"${logicalId}_${newRev}")
    doc.put("logical_id",  logicalId)
    doc.put("id",          logicalId)
    doc.put("kind",        "region")
    doc.put("name",        r.label)
    doc.put("attrs",       mapper.readValue(attrsJson, classOf[java.util.Map[String, AnyRef]]))
    doc.put("provenance",  provMap)
    doc.put("created_rev", Long.box(newRev))
    doc.put("deleted_rev", null)
    doc.put("created_at",  now)
    doc.put("updated_at",  now)
    doc
  }

  private def buildRegionEdgeDocs(
    regions: Vector[Region],
    newRev:  Long,
    now:     String,
    provMap: java.util.Map[String, AnyRef]
  ): Vector[java.util.Map[String, AnyRef]] = {
    val fileEdges = regions.filter(_.level == 1).flatMap { r =>
      r.memberFiles.toVector.map { fileId =>
        val edgeId = UUID.nameUUIDFromBytes(s"in_region:${r.id.value}:${fileId.value}".getBytes("UTF-8"))
        buildRegionEdgeDoc(edgeId.toString, s"nodes/${r.id.value}", s"nodes/${fileId.value}",
          r.id.value.toString, fileId.value.toString, newRev, now, provMap)
      }
    }
    val regionEdges = regions.flatMap { r =>
      r.parentId.map { pid =>
        val edgeId = UUID.nameUUIDFromBytes(s"in_region:${pid.value}:${r.id.value}".getBytes("UTF-8"))
        buildRegionEdgeDoc(edgeId.toString, s"nodes/${pid.value}", s"nodes/${r.id.value}",
          pid.value.toString, r.id.value.toString, newRev, now, provMap)
      }
    }
    fileEdges ++ regionEdges
  }

  private def buildRegionEdgeDoc(
    key:     String,
    from:    String,
    to:      String,
    src:     String,
    dst:     String,
    newRev:  Long,
    now:     String,
    provMap: java.util.Map[String, AnyRef]
  ): java.util.Map[String, AnyRef] = {
    val doc = new java.util.HashMap[String, AnyRef]()
    doc.put("_key",        key)
    doc.put("_from",       from)
    doc.put("_to",         to)
    doc.put("id",          key)
    doc.put("src",         src)
    doc.put("dst",         dst)
    doc.put("predicate",   "IN_REGION")
    doc.put("attrs",       new java.util.HashMap[String, AnyRef]())
    doc.put("created_rev", Long.box(newRev))
    doc.put("deleted_rev", null)
    doc.put("provenance",  provMap)
    doc.put("created_at",  now)
    doc.put("updated_at",  now)
    doc
  }
}
