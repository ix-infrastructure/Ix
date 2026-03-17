package ix.memory.map

import cats.effect.IO

import ix.memory.db.ArangoClient
import ix.memory.model.NodeId

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
 *   β = 0.7  import coupling
 *   γ = 0.9  extends/implements  (type/interface cohesion proxy)
 *   ε = 0.3  path proximity      (weak structural prior)
 */
class MapGraphBuilder(client: ArangoClient) {

  private val Alpha   = 1.0
  private val Beta    = 0.7
  private val Gamma   = 0.9
  private val Epsilon = 0.3

  def build(): IO[WeightedFileGraph] =
    for {
      files    <- fetchFiles()
      rawPairs <- fetchCouplingByUri()
      graph     = computeGraph(files, rawPairs)
    } yield graph

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
        |  RETURN {id: n.logical_id, path: n.provenance.source_uri}""".stripMargin,
      Map.empty
    ).map { rows =>
      rows.flatMap { json =>
        val c = json.hcursor
        for {
          idStr <- c.get[String]("id").toOption
          path  <- c.get[String]("path").toOption
          ext    = path.split("\\.").lastOption.getOrElse("").toLowerCase
          if SourceExtensions.contains(ext)
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
      """LET uri_map = MERGE(
        |  FOR n IN nodes
        |    FILTER n.deleted_rev == null
        |      AND n.provenance.source_uri != null
        |      AND n.kind NOT IN ["module","config","config_entry",
        |                         "doc","decision","intent","bug","plan",
        |                         "task","goal","region"]
        |    RETURN {[n.logical_id]: n.provenance.source_uri}
        |)
        |FOR e IN edges
        |  FILTER e.predicate IN ["CALLS","IMPORTS","EXTENDS","IMPLEMENTS"]
        |    AND e.deleted_rev == null
        |  LET su = HAS(uri_map, e.src) ? uri_map[e.src] : null
        |  LET du = HAS(uri_map, e.dst) ? uri_map[e.dst] : null
        |  FILTER su != null AND du != null AND su != du
        |  COLLECT srcUri = su, dstUri = du, pred = e.predicate
        |    WITH COUNT INTO cnt
        |  RETURN {srcUri, dstUri, predicate: pred, count: cnt}""".stripMargin,
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
    files:    Vector[FileVertex],
    rawPairs: Vector[RawFilePair]
  ): WeightedFileGraph = {
    if (files.isEmpty) return WeightedFileGraph.empty

    // Index files by their absolute source_uri path
    val byUri: Map[String, FileVertex] = files.map(v => v.path -> v).toMap

    // Accumulate coupling counts per (srcUri, dstUri) canonical pair
    val pairAcc =
      scala.collection.mutable.Map[(String, String), scala.collection.mutable.Map[String, Int]]()

    for (pair <- rawPairs) {
      val sv = byUri.get(pair.srcId)   // srcId is source_uri here
      val dv = byUri.get(pair.dstId)
      (sv, dv) match {
        case (Some(s), Some(d)) if s.id != d.id =>
          // Canonical undirected key: lexicographically smaller path first
          val key = if (s.path < d.path) (s.path, d.path) else (d.path, s.path)
          val m   = pairAcc.getOrElseUpdate(key, scala.collection.mutable.Map())
          m(pair.predicate) = m.getOrElse(pair.predicate, 0) + pair.count
        case _ =>
      }
    }

    // Build adjacency with composite weights
    val adjMut =
      scala.collection.mutable.Map[NodeId, scala.collection.mutable.Map[NodeId, Double]]()

    for (((sp, dp), predicateCounts) <- pairAcc) {
      val sv = byUri(sp)
      val dv = byUri(dp)

      val callCount   = predicateCounts.getOrElse("CALLS", 0)
      val importCount = predicateCounts.getOrElse("IMPORTS", 0)
      val typeCount   = predicateCounts.getOrElse("EXTENDS", 0) +
                        predicateCounts.getOrElse("IMPLEMENTS", 0)

      val sCall   = Alpha   * math.log1p(callCount)
      val sImport = Beta    * math.log1p(importCount)
      val sType   = Gamma   * math.log1p(typeCount)
      val sPath   = Epsilon * pathProximity(sv.path, dv.path)

      val w = sCall + sImport + sType + sPath
      if (w > 0.0) {
        adjMut.getOrElseUpdate(sv.id, scala.collection.mutable.Map())(dv.id) = w
        adjMut.getOrElseUpdate(dv.id, scala.collection.mutable.Map())(sv.id) = w
      }
    }

    // Path-proximity pass: add structural edges for same-directory file pairs
    // that have no existing coupling edge.  This ensures isolated files (no
    // CALLS/IMPORTS/EXTENDS edges) can still be clustered by directory.
    val filesByDir = files.groupBy(v => v.path.split("[/\\\\]").dropRight(1).mkString("/"))
    for ((_, dirFiles) <- filesByDir if dirFiles.size >= 2) {
      for (i <- dirFiles.indices; j <- (i + 1) until dirFiles.size) {
        val sv = dirFiles(i)
        val dv = dirFiles(j)
        if (!adjMut.get(sv.id).exists(_.contains(dv.id))) {
          val w = Epsilon * pathProximity(sv.path, dv.path)
          if (w > 0.0) {
            adjMut.getOrElseUpdate(sv.id, scala.collection.mutable.Map())(dv.id) = w
            adjMut.getOrElseUpdate(dv.id, scala.collection.mutable.Map())(sv.id) = w
          }
        }
      }
    }

    val adj         = adjMut.map { case (k, m) => k -> m.toMap }.toMap
    val degrees     = adj.map { case (k, m) => k -> m.values.sum }
    val totalWeight = degrees.values.sum / 2.0

    WeightedFileGraph(files, adj, degrees.toMap, totalWeight)
  }

  /** Path distance heuristic: deeper common prefix → higher proximity. */
  private def pathProximity(a: String, b: String): Double = {
    val partsA = a.split("[/\\\\]").dropRight(1)
    val partsB = b.split("[/\\\\]").dropRight(1)
    val common = partsA.zip(partsB).takeWhile { case (x, y) => x == y }.length
    val dist   = (partsA.length - common) + (partsB.length - common)
    1.0 / (1.0 + dist)
  }
}
