package ix.memory.api

import cats.effect.IO
import io.circe.Json
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.map.{ArchitectureMap, MapService, Region}
import ix.memory.model.NodeId

class MapRoutes(mapService: MapService) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {

    /** POST /v1/map — Run the full map pipeline and return the hierarchy. */
    case POST -> Root / "v1" / "map" =>
      (for {
        archMap <- mapService.buildMap()
        resp    <- Ok(encodeMap(archMap))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }

  private def encodeMap(m: ArchitectureMap): Json = {
    val regionsByLevel = m.regions.groupBy(_.level).toVector.sortBy(_._1)

    Json.obj(
      "file_count"   -> m.fileCount.asJson,
      "region_count" -> m.regions.size.asJson,
      "levels"       -> regionsByLevel.size.asJson,
      "map_rev"      -> m.mapRev.asJson,
      "regions"      -> m.regions.sortBy(r => (r.level, r.label)).map(encodeRegion).asJson,
      "hierarchy"    -> buildHierarchyTree(m).asJson
    )
  }

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
