package ix.memory.map

import cats.effect.IO
import org.typelevel.log4cats.slf4j.Slf4jLogger

import ix.memory.db.ArangoClient
import ix.memory.model.{NodeId, Rev}

/**
 * Builds a weighted undirected file-level coupling graph from ArangoDB.
 *
 * Key design choices:
 *   - Uses provenance.source_uri (absolute path) as the join key between file
 *     nodes and coupling edges, avoiding stale CONTAINS traversals.
 *   - Skips edges where either endpoint has no live provenance (external libs,
 *     tombstoned symbols with no replacement).
 *
 * Signal weights (from spec):
 *   α = 1.0  call coupling       (highest importance)
 *   β = 0.5  import coupling
 *   γ = 1.2  extends/implements  (type/interface cohesion proxy)
 *   ε = 0.2  path proximity      (weak structural prior)
 */
class MapGraphBuilder(client: ArangoClient) {
  private val logger = Slf4jLogger.getLoggerFromName[IO]("ix.map.build")

  private val Alpha   = 1.0
  private val Beta    = 0.5
  private val Gamma   = 1.2
  private val Epsilon = 0.2
  private val MaxEdges = 200000
  private val PathProximityMinFiles = 2
  private val PathProximityMaxFiles = 50
  private val SourceGraphRevisionKey = "source-graph"
  private val IgnoredNodeKinds = Vector(
    "module", "config", "config_entry", "doc", "decision", "intent",
    "bug", "plan", "task", "goal", "region",
    "chunk"  // chunks are code-text segments, never CALLS/IMPORTS/EXTENDS/IMPLEMENTS endpoints
  )
  private val CouplingPredicates = Vector("CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS")

  def discoverFiles(): IO[Vector[FileVertex]] = fetchFiles()

  def buildGraph(files: Vector[FileVertex]): IO[WeightedFileGraph] =
    for {
      t0       <- IO(System.currentTimeMillis())
      rawPairs <- fetchCouplingByUri()
      t1       <- IO(System.currentTimeMillis())
      graph     = computeGraph(files, rawPairs)
      t2       <- IO(System.currentTimeMillis())
      _        <- logger.info(
                    s"map graph files=${files.size} raw_pairs=${rawPairs.size} fetch=${t1-t0}ms compute=${t2-t1}ms total=${t2-t0}ms"
                  )
    } yield graph

  def build(): IO[WeightedFileGraph] =
    for {
      files <- discoverFiles()
      graph <- buildGraph(files)
    } yield graph

  /**
   * Revision of the graph inputs that materially affect architecture mapping.
   * This intentionally ignores derived artifacts like persisted region nodes or
   * scoring claims so cached maps stay reusable across unchanged source graphs.
   */
  def currentInputRev(): IO[Rev] =
    loadSourceGraphRevision().flatMap {
      case Some(rev) => IO.pure(rev)
      case None      => scanCurrentInputRev()
    }

  private def loadSourceGraphRevision(): IO[Option[Rev]] =
    client.queryOne(
      """FOR r IN revisions
        |  FILTER r._key == @key
        |  LIMIT 1
        |  RETURN r.rev""".stripMargin,
      Map("key" -> SourceGraphRevisionKey.asInstanceOf[AnyRef])
    ).map(_.flatMap(_.as[Long].toOption).map(Rev(_)))

  private def scanCurrentInputRev(): IO[Rev] =
    client.queryOne(
      """LET node_rev = MAX(
        |  FOR n IN nodes
        |    FILTER n.provenance.source_uri != null
        |      AND n.kind NOT IN @ignoredKinds
        |    RETURN MAX([
        |      TO_NUMBER(n.created_rev),
        |      n.deleted_rev != null ? TO_NUMBER(n.deleted_rev) : 0
        |    ])
        |)
        |LET edge_rev = MAX(
        |  FOR e IN edges
        |    FILTER e.predicate IN @predicates
        |    RETURN MAX([
        |      TO_NUMBER(e.created_rev),
        |      e.deleted_rev != null ? TO_NUMBER(e.deleted_rev) : 0
        |    ])
        |)
        |RETURN MAX([
        |  node_rev != null ? node_rev : 0,
        |  edge_rev != null ? edge_rev : 0
        |])""".stripMargin,
      Map(
        "ignoredKinds" -> IgnoredNodeKinds.toArray.asInstanceOf[AnyRef],
        "predicates"   -> CouplingPredicates.toArray.asInstanceOf[AnyRef]
      )
    ).map { json =>
      Rev(json.flatMap(_.as[Long].toOption).getOrElse(0L))
    }

  def liveFileCount(): IO[Int] =
    client.queryOne(
      """FOR n IN nodes
        |  FILTER n.kind == "file"
        |    AND n.deleted_rev == null
        |    AND n.provenance.source_uri != null
        |  LET ext = LOWER(LAST(SPLIT(n.provenance.source_uri, ".")))
        |  FILTER ext IN @extensions
        |  COLLECT WITH COUNT INTO cnt
        |  RETURN cnt""".stripMargin,
      Map("extensions" -> SourceExtensions.toArray.asInstanceOf[AnyRef])
    ).map(_.flatMap(_.as[Int].toOption).getOrElse(0))

  // ── ArangoDB queries ───────────────────────────────────────────────

  /**
   * Returns file nodes using provenance.source_uri as the path key.
   * Files without source_uri are skipped (unusual but defensive).
   */
  // Source-code extensions to include in the architectural map.
  // Docs (.md), scripts (.sh), config (.yml/.json/.toml) etc. are excluded.
  private val SourceExtensions =
    Set("scala","java","kt","ts","tsx","js","jsx","py","go","rs","cs","cpp","c","h","hpp","rb")

  private def fetchFiles(): IO[Vector[FileVertex]] =
    client.query(
      """FOR n IN nodes
        |  FILTER n.kind == "file"
        |    AND n.deleted_rev == null
        |    AND n.provenance.source_uri != null
        |  LET ext = LOWER(LAST(SPLIT(n.provenance.source_uri, ".")))
        |  FILTER ext IN @extensions
        |  RETURN {id: n.logical_id, path: n.provenance.source_uri}""".stripMargin,
      Map("extensions" -> SourceExtensions.toArray.asInstanceOf[AnyRef])
    ).map { rows =>
      rows.flatMap { json =>
        val c = json.hcursor
        for {
          idStr <- c.get[String]("id").toOption
          path  <- c.get[String]("path").toOption
          uuid  <- try Some(java.util.UUID.fromString(idStr)) catch { case _: Exception => None }
        } yield FileVertex(NodeId(uuid), path)
      }.toVector
    }

  /**
   * Returns cross-file coupling pairs keyed by absolute provenance.source_uri.
   *
   * Builds a unified logical_id → source_uri map over all live non-metadata
   * nodes (files AND symbols), then resolves coupling edge endpoints via that
   * map.  Stale edges whose endpoints have been tombstoned are naturally
   * excluded because deleted nodes have no entry in the map.
   */
  private def fetchCouplingByUri(): IO[Vector[RawFilePair]] =
    client.query(
      """LET uriMap = (
        |  FOR n IN nodes
        |    FILTER n.deleted_rev == null
        |      AND n.provenance.source_uri != null
        |      AND n.kind NOT IN @ignoredKinds
        |    RETURN { id: n.logical_id, uri: n.provenance.source_uri }
        |)
        |LET byId = ZIP(uriMap[*].id, uriMap[*].uri)
        |FOR e IN edges
        |  FILTER e.predicate IN @predicates
        |    AND e.deleted_rev == null
        |  LET su = byId[e.src]
        |  LET du = byId[e.dst]
        |  FILTER su != null AND du != null AND su != du
        |  COLLECT srcUri = su, dstUri = du, pred = e.predicate
        |    WITH COUNT INTO cnt
        |  RETURN {srcUri, dstUri, predicate: pred, count: cnt}""".stripMargin,
      Map(
        "ignoredKinds" -> IgnoredNodeKinds.toArray.asInstanceOf[AnyRef],
        "predicates"   -> CouplingPredicates.toArray.asInstanceOf[AnyRef]
      )
    ).map { rows =>
      rows.flatMap { json =>
        val c = json.hcursor
        for {
          srcUri <- c.get[String]("srcUri").toOption
          dstUri <- c.get[String]("dstUri").toOption
          pred   <- c.get[String]("predicate").toOption
          cnt    <- c.get[Int]("count").toOption
        } yield RawFilePair(srcUri, dstUri, pred, cnt)
      }.toVector
    }

  // ── Graph construction ─────────────────────────────────────────────

  private def computeGraph(
    files:    Vector[FileVertex],
    rawPairs: Vector[RawFilePair]
  ): WeightedFileGraph = {
    if (files.isEmpty) return WeightedFileGraph.empty

    // Index files by their absolute source_uri path
    val byUri: Map[String, FileVertex] = files.map(v => v.path -> v).toMap
    val byId: Map[NodeId, FileVertex]  = files.map(v => v.id -> v).toMap
    val pathSegmentsById: Map[NodeId, Array[String]] =
      files.map(v => v.id -> directorySegments(v.path)).toMap

    // Accumulate coupling counts per canonical file-id pair.
    val pairAcc =
      scala.collection.mutable.Map[(NodeId, NodeId), scala.collection.mutable.Map[String, Int]]()

    for (pair <- rawPairs) {
      val sv = byUri.get(pair.srcId)   // srcId is source_uri here
      val dv = byUri.get(pair.dstId)
      (sv, dv) match {
        case (Some(s), Some(d)) if s.id != d.id =>
          val key = canonicalPair(s.id, d.id)
          val m   = pairAcc.getOrElseUpdate(key, scala.collection.mutable.Map())
          m(pair.predicate) = m.getOrElse(pair.predicate, 0) + pair.count
        case _ =>
      }
    }

    // Build adjacency with composite weights
    val adjMut =
      scala.collection.mutable.Map[NodeId, scala.collection.mutable.Map[NodeId, Double]]()
    val predicatePairs =
      scala.collection.mutable.Map[(NodeId, NodeId), Map[String, Int]]()
    var edgeCount = 0

    for (((srcId, dstId), predicateCounts) <- pairAcc.iterator) {
      val sv = byId(srcId)
      val dv = byId(dstId)
      val srcSegments = pathSegmentsById(srcId)
      val dstSegments = pathSegmentsById(dstId)
      val sameDir     = isSameDirectory(srcSegments, dstSegments)

      val callCount   = predicateCounts.getOrElse("CALLS", 0)
      val importCount = predicateCounts.getOrElse("IMPORTS", 0)
      val typeCount   = predicateCounts.getOrElse("EXTENDS", 0) +
                        predicateCounts.getOrElse("IMPLEMENTS", 0)
      val pairSignals =
        if (sameDir) predicateCounts.toMap.updated("PATH", predicateCounts.getOrElse("PATH", 0) + 1)
        else predicateCounts.toMap

      val sCall   = Alpha   * math.log1p(callCount)
      val sImport = Beta    * math.log1p(importCount)
      val sType   = Gamma   * math.log1p(typeCount)
      val sPath   = Epsilon * pathProximity(srcSegments, dstSegments, sameDir)

      val w = sCall + sImport + sType + sPath
      if (w > 0.0) {
        adjMut.getOrElseUpdate(sv.id, scala.collection.mutable.Map())(dv.id) = w
        adjMut.getOrElseUpdate(dv.id, scala.collection.mutable.Map())(sv.id) = w
        predicatePairs((srcId, dstId)) = pairSignals
        edgeCount += 1
      }
    }

    // Path-proximity pass: add structural edges for same-directory file pairs
    // that have no existing coupling edge.  This ensures isolated files (no
    // CALLS/IMPORTS/EXTENDS edges) can still be clustered by directory.
    val filesByDir =
      files.groupBy(v => pathSegmentsById(v.id).mkString("/")).toVector.sortBy(_._1)
    for ((_, dirFiles) <- filesByDir if dirFiles.size >= PathProximityMinFiles &&
                                      dirFiles.size <= PathProximityMaxFiles &&
                                      edgeCount < MaxEdges) {
      val ordered = dirFiles.sortBy(_.path)
      var i = 0
      while (i < ordered.length - 1 && edgeCount < MaxEdges) {
        var j = i + 1
        while (j < ordered.length && edgeCount < MaxEdges) {
          val sv = ordered(i)
          val dv = ordered(j)
          if (!adjMut.get(sv.id).exists(_.contains(dv.id))) {
            adjMut.getOrElseUpdate(sv.id, scala.collection.mutable.Map())(dv.id) = Epsilon
            adjMut.getOrElseUpdate(dv.id, scala.collection.mutable.Map())(sv.id) = Epsilon
            predicatePairs(canonicalPair(sv.id, dv.id)) = Map("PATH" -> 1)
            edgeCount += 1
          }
          j += 1
        }
        i += 1
      }
    }

    val adj         = adjMut.map { case (k, m) => k -> m.toMap }.toMap
    val degrees     = adj.map { case (k, m) => k -> m.values.sum }
    val totalWeight = degrees.values.sum / 2.0

    WeightedFileGraph(files, adj, degrees.toMap, totalWeight, predicatePairs.toMap)
  }

  private def canonicalPair(a: NodeId, b: NodeId): (NodeId, NodeId) =
    if (a.value.compareTo(b.value) <= 0) (a, b) else (b, a)

  private def directorySegments(path: String): Array[String] =
    path.split("[/\\\\]").dropRight(1)

  private def isSameDirectory(partsA: Array[String], partsB: Array[String]): Boolean = {
    if (partsA.length != partsB.length) return false
    var i = 0
    while (i < partsA.length) {
      if (partsA(i) != partsB(i)) return false
      i += 1
    }
    true
  }

  /** Path distance heuristic: deeper common prefix → higher proximity. */
  private def pathProximity(partsA: Array[String], partsB: Array[String], sameDir: Boolean): Double = {
    if (sameDir) return 1.0

    val maxLen = math.min(partsA.length, partsB.length)
    var common = 0
    while (common < maxLen && partsA(common) == partsB(common)) {
      common += 1
    }
    val dist   = (partsA.length - common) + (partsB.length - common)
    1.0 / (1.0 + dist)
  }
}
