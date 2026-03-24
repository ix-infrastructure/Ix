package ix.memory.map

import cats.effect.IO
import org.typelevel.log4cats.slf4j.Slf4jLogger

import ix.memory.db.ArangoClient
import ix.memory.model.NodeId

/**
 * Fast graph builder for large workloads.
 *
 * Builds a WeightedFileGraph using only cheap file-level signals:
 *   1. File-to-file IMPORTS edges (direct query, no uri_map or symbol traversal)
 *   2. Directory chain structure (O(n) per directory, not O(n²) pairwise)
 *
 * The resulting graph is fully compatible with the downstream pipeline
 * (cross-cut detection, penalty, Louvain clustering, region creation, persistence).
 */
class MapGraphBuilderFast(client: ArangoClient) {

  private val logger = Slf4jLogger.getLoggerFromName[IO]("ix.map.fast")

  // Weights aligned with full mode for comparable downstream behavior
  private val ImportWeight    = 0.7   // matches full mode β
  private val DirectoryWeight = 0.3   // matches full mode ε

  def buildGraph(files: Vector[FileVertex]): IO[WeightedFileGraph] =
    for {
      _           <- logger.info("Using fast map graph construction (reduced coupling model)")
      fileImports <- fetchFileImports()
      graph        = computeGraph(files, fileImports)
      _           <- logger.debug(
        s"Fast graph: ${files.size} files, " +
        s"${fileImports.size} file-level import edges, " +
        s"adj entries=${graph.adjMatrix.size}"
      )
    } yield graph

  // ── Cheap AQL query ────────────────────────────────────────────────

  /**
   * Fetches file-to-file IMPORTS edges directly.
   *
   * This is cheap because:
   *   - Filters to IMPORTS only (no CALLS/EXTENDS/IMPLEMENTS)
   *   - Joins against file nodes only (indexed logical_id lookup)
   *   - Does NOT build a uri_map or scan all symbols
   *   - Result set is small (file-to-file edges are a fraction of all edges)
   */
  private def fetchFileImports(): IO[Vector[RawFilePair]] =
    client.query(
      """FOR e IN edges
        |  FILTER e.predicate == "IMPORTS"
        |    AND e.deleted_rev == null
        |  LET srcFile = FIRST(
        |    FOR n IN nodes
        |      FILTER n.logical_id == e.src
        |        AND n.kind == "file"
        |        AND n.deleted_rev == null
        |        AND n.provenance.source_uri != null
        |      RETURN n.provenance.source_uri
        |  )
        |  LET dstFile = FIRST(
        |    FOR n IN nodes
        |      FILTER n.logical_id == e.dst
        |        AND n.kind == "file"
        |        AND n.deleted_rev == null
        |        AND n.provenance.source_uri != null
        |      RETURN n.provenance.source_uri
        |  )
        |  FILTER srcFile != null AND dstFile != null AND srcFile != dstFile
        |  COLLECT srcUri = srcFile, dstUri = dstFile
        |    WITH COUNT INTO cnt
        |  RETURN {srcUri, dstUri, predicate: "IMPORTS", count: cnt}""".stripMargin,
      Map.empty
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
    files:       Vector[FileVertex],
    fileImports: Vector[RawFilePair]
  ): WeightedFileGraph = {
    if (files.isEmpty) return WeightedFileGraph.empty

    val byUri: Map[String, FileVertex] = files.map(v => v.path -> v).toMap

    val adjMut =
      scala.collection.mutable.Map[NodeId, scala.collection.mutable.Map[NodeId, Double]]()

    def addEdge(a: NodeId, b: NodeId, w: Double): Unit = {
      adjMut.getOrElseUpdate(a, scala.collection.mutable.Map())(b) =
        adjMut.getOrElseUpdate(a, scala.collection.mutable.Map()).getOrElse(b, 0.0) + w
      adjMut.getOrElseUpdate(b, scala.collection.mutable.Map())(a) =
        adjMut.getOrElseUpdate(b, scala.collection.mutable.Map()).getOrElse(a, 0.0) + w
    }

    // Signal 1: File-level import edges
    for (pair <- fileImports) {
      val sv = byUri.get(pair.srcId)
      val dv = byUri.get(pair.dstId)
      (sv, dv) match {
        case (Some(s), Some(d)) if s.id != d.id =>
          addEdge(s.id, d.id, ImportWeight * math.log1p(pair.count))
        case _ =>
      }
    }

    // Signal 2: Directory chain (O(n) per directory, not O(n²) pairwise)
    // For each directory, sort files by path and connect consecutive pairs.
    // This creates a linear chain that gives Louvain enough signal to group
    // co-located files without quadratic blowup.
    val filesByDir = files.groupBy { v =>
      val parts = v.path.split("[/\\\\]")
      if (parts.length > 1) parts.dropRight(1).mkString("/") else "."
    }
    for ((_, dirFiles) <- filesByDir if dirFiles.size >= 2) {
      val sorted = dirFiles.sortBy(_.path)
      for (i <- 0 until sorted.size - 1) {
        val a = sorted(i)
        val b = sorted(i + 1)
        // Boost weight for files already connected by imports
        val existing = adjMut.get(a.id).flatMap(_.get(b.id)).getOrElse(0.0)
        if (existing > 0.0) {
          // Directory co-location boost on existing edge
          addEdge(a.id, b.id, DirectoryWeight)
        } else {
          // New structural edge for unconnected neighbors
          addEdge(a.id, b.id, DirectoryWeight * pathProximity(a.path, b.path))
        }
      }
    }

    val adj         = adjMut.map { case (k, m) => k -> m.toMap }.toMap
    val degrees     = adj.map { case (k, m) => k -> m.values.sum }
    val totalWeight = degrees.values.sum / 2.0

    WeightedFileGraph(files, adj, degrees.toMap, totalWeight, Map.empty)
  }

  private def pathProximity(a: String, b: String): Double = {
    val partsA = a.split("[/\\\\]").dropRight(1)
    val partsB = b.split("[/\\\\]").dropRight(1)
    val common = partsA.zip(partsB).takeWhile { case (x, y) => x == y }.length
    val dist   = (partsA.length - common) + (partsB.length - common)
    1.0 / (1.0 + dist)
  }
}
