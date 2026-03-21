package ix.memory.api

import cats.effect.IO
import io.circe.{Decoder, Json}
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.map.{ArchitectureMap, MapPreflightResult, MapService, PersistenceEstimate, Region}
import ix.memory.model.NodeId

class MapRoutes(mapService: MapService) {

  private case class MapRequest(full: Option[Boolean])
  private implicit val mapReqDecoder: Decoder[MapRequest] = deriveDecoder

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** POST /v1/map — Run the full map pipeline and return the hierarchy. */
    case req @ POST -> Root / "v1" / "map" =>
      (for {
        body    <- req.as[MapRequest].handleErrorWith(_ => IO.pure(MapRequest(None)))
        archMap <- mapService.buildMap(forceFullLocal = body.full.getOrElse(false))
        resp    <- Ok(encodeMap(archMap))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def encodeMap(m: ArchitectureMap): Json = {
    val regionsByLevel = m.regions.groupBy(_.level).toVector.sortBy(_._1)

    val base = Json.obj(
      "file_count"   -> m.fileCount.asJson,
      "region_count" -> m.regions.size.asJson,
      "levels"       -> regionsByLevel.size.asJson,
      "map_rev"      -> m.mapRev.asJson,
      "regions"      -> m.regions.sortBy(r => (r.level, r.label)).map(encodeRegion).asJson,
      "hierarchy"    -> buildHierarchyTree(m).asJson
    )

    val withOutcome = base.deepMerge(Json.obj("outcome" -> m.outcome.label.asJson))

    val withPreflight = m.preflight match {
      case Some(pf) => withOutcome.deepMerge(Json.obj("preflight" -> encodePreflight(pf)))
      case None     => withOutcome
    }

    m.persistenceEstimate match {
      case Some(pe) => withPreflight.deepMerge(Json.obj("persistence" -> encodePersistence(pe)))
      case None     => withPreflight
    }
  }

  private def encodePreflight(pf: MapPreflightResult): Json =
    Json.obj(
      "cost" -> Json.obj(
        "file_count"           -> pf.cost.fileCount.asJson,
        "directory_count"      -> pf.cost.directoryCount.asJson,
        "directory_quadratic"  -> pf.cost.directoryQuadratic.asJson,
        "symbol_estimate"      -> pf.cost.symbolEstimate.asJson,
        "edge_estimate"        -> pf.cost.edgeEstimate.asJson
      ),
      "capacity" -> Json.obj(
        "cpu_cores"        -> pf.capacity.cpuCores.asJson,
        "heap_max_bytes"   -> pf.capacity.heapMaxBytes.asJson,
        "heap_free_bytes"  -> pf.capacity.heapFreeBytes.asJson,
        "container_memory" -> pf.capacity.containerMemory.asJson,
        "disk_free_bytes"  -> pf.capacity.diskFreeBytes.asJson
      ),
      "risk"        -> pf.risk.label.asJson,
      "mode"        -> pf.mode.label.asJson,
      "warnings"    -> pf.warnings.asJson,
      "duration_ms" -> pf.durationMs.asJson
    )

  private def encodePersistence(pe: PersistenceEstimate): Json =
    Json.obj(
      "region_nodes"  -> pe.regionNodes.asJson,
      "file_edges"    -> pe.fileEdges.asJson,
      "region_edges"  -> pe.regionEdges.asJson,
      "delete_ops"    -> pe.deleteOps.asJson,
      "total_ops"     -> pe.totalOps.asJson
    )

  private def encodeRegion(r: Region): Json =
    Json.obj(
      "id"                  -> r.id.value.toString.asJson,
      "label"               -> r.label.asJson,
      "label_kind"          -> r.labelKind.asJson,
      "level"               -> r.level.asJson,
      "file_count"          -> r.memberFiles.size.asJson,
      "child_region_count"  -> r.childRegionIds.size.asJson,
      "parent_id"           -> r.parentId.map(_.value.toString).asJson,
      "cohesion"            -> r.cohesion.asJson,
      "external_coupling"   -> r.externalCoupling.asJson,
      "boundary_ratio"      -> r.boundaryRatio.asJson,
      "confidence"          -> r.confidence.asJson,
      "crosscut_score"      -> r.crosscutScore.asJson,
      "dominant_signals"    -> r.dominantSignals.asJson,
      "interface_node_count" -> r.interfaceNodeCount.asJson
    )

  /**
   * Build a tree structure: top-level regions contain nested children.
   * Returns a JSON array of root regions (no parent), each with a recursive
   * `children` field.
   */
  private def buildHierarchyTree(m: ArchitectureMap): Json = {
    val regionById: Map[NodeId, Region] = m.regions.map(r => r.id -> r).toMap

    // Guard against cycles (can arise when Louvain levels have identical partitions)
    def renderNode(r: Region, visited: Set[NodeId]): Json = {
      val children =
        if (visited.contains(r.id)) Vector.empty
        else r.childRegionIds.toVector
          .flatMap(cid => regionById.get(cid))
          .filter(c => c.level < r.level)       // strict level ordering: child must be finer
          .sortBy(_.label)
          .map(c => renderNode(c, visited + r.id))

      encodeRegion(r).deepMerge(Json.obj("children" -> children.asJson))
    }

    val roots = m.regions.filter(_.parentId.isEmpty).sortBy(-_.level)
    roots.map(r => renderNode(r, Set.empty)).asJson
  }
}
