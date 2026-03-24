package ix.memory.api

import io.circe.Json
import io.circe.syntax._

import ix.memory.map.{ArchitectureMap, Region, RegionMatch, ScopedSubsystemView}
import ix.memory.model.NodeId

/** Shared JSON encoding for ArchitectureMap, used by MapRoutes and SubsystemRoutes. */
object MapEncoder {

  def encodeMap(m: ArchitectureMap): Json = {
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

  def encodeRegion(r: Region): Json =
    Json.obj(
      "id"                   -> r.id.value.toString.asJson,
      "label"                -> r.label.asJson,
      "label_kind"           -> r.labelKind.asJson,
      "level"                -> r.level.asJson,
      "file_count"           -> r.memberFiles.size.asJson,
      "child_region_count"   -> r.childRegionIds.size.asJson,
      "parent_id"            -> r.parentId.map(_.value.toString).asJson,
      "cohesion"             -> r.cohesion.asJson,
      "external_coupling"    -> r.externalCoupling.asJson,
      "boundary_ratio"       -> r.boundaryRatio.asJson,
      "confidence"           -> r.confidence.asJson,
      "crosscut_score"       -> r.crosscutScore.asJson,
      "dominant_signals"     -> r.dominantSignals.asJson,
      "interface_node_count" -> r.interfaceNodeCount.asJson
    )

  def encodeScopedView(view: ScopedSubsystemView, isCrossCutting: Region => Boolean): Json =
    Json.obj(
      "target" -> encodeScopedRegion(view.target, isCrossCutting).asJson,
      "parent" -> view.parent.map(parent =>
        Json.obj(
          "id"         -> parent.id.value.toString.asJson,
          "label"      -> parent.label.asJson,
          "level"      -> parent.level.asJson,
          "label_kind" -> parent.labelKind.asJson
        )
      ).asJson,
      "summary" -> Json.obj(
        "well_defined" -> view.summary.wellDefined.asJson,
        "moderate"     -> view.summary.moderate.asJson,
        "fuzzy"        -> view.summary.fuzzy.asJson,
        "cross_cutting" -> view.summary.crossCutting.asJson
      ),
      "children" -> view.children.map(child => encodeScopedRegion(child, isCrossCutting)).asJson,
      "hierarchy" -> buildScopedTree(view, isCrossCutting).asJson
    )

  def encodeAmbiguousTarget(target: String, candidates: Vector[RegionMatch], parentOf: Region => Option[Region]): Json =
    Json.obj(
      "error" -> "ambiguous_target".asJson,
      "target_query" -> target.asJson,
      "candidates" -> candidates.zipWithIndex.map { case (candidate, idx) =>
        val region = candidate.region
        Json.obj(
          "pick"       -> (idx + 1).asJson,
          "id"         -> region.id.value.toString.asJson,
          "label"      -> region.label.asJson,
          "level"      -> region.level.asJson,
          "label_kind" -> region.labelKind.asJson,
          "file_count" -> region.memberFiles.size.asJson,
          "parent"     -> parentOf(region).map(_.label).asJson
        )
      }.asJson
    )

  def buildHierarchyTree(m: ArchitectureMap): Json = {
    val regionById: Map[NodeId, Region] = m.regions.map(r => r.id -> r).toMap

    // Guard against cycles (can arise when Louvain levels have identical partitions)
    def renderNode(r: Region, visited: Set[NodeId]): Json = {
      val children =
        if (visited.contains(r.id)) Vector.empty
        else r.childRegionIds.toVector
          .flatMap(cid => regionById.get(cid))
          .filter(c => c.level < r.level)
          .sortBy(_.label)
          .map(c => renderNode(c, visited + r.id))

      encodeRegion(r).deepMerge(Json.obj("children" -> children.asJson))
    }

    val roots = m.regions.filter(_.parentId.isEmpty).sortBy(-_.level)
    roots.map(r => renderNode(r, Set.empty)).asJson
  }

  private def encodeScopedRegion(region: Region, isCrossCutting: Region => Boolean): Json =
    Json.obj(
      "id" -> region.id.value.toString.asJson,
      "label" -> region.label.asJson,
      "level" -> region.level.asJson,
      "label_kind" -> region.labelKind.asJson,
      "parent_id" -> region.parentId.map(_.value.toString).asJson,
      "file_count" -> region.memberFiles.size.asJson,
      "confidence" -> region.confidence.asJson,
      "is_cross_cutting" -> isCrossCutting(region).asJson,
      "dominant_signals" -> region.dominantSignals.asJson
    )

  private def buildScopedTree(view: ScopedSubsystemView, isCrossCutting: Region => Boolean): Json = {
    val regionsById = view.subtree.map(region => region.id -> region).toMap

    def renderNode(region: Region, visited: Set[NodeId]): Json = {
      val children =
        if (visited.contains(region.id)) Vector.empty
        else region.childRegionIds.toVector
          .flatMap(regionsById.get)
          .filter(_.level < region.level)
          .sortBy(child => (-child.memberFiles.size, -child.confidence, child.label.toLowerCase))
          .map(child => renderNode(child, visited + region.id))

      encodeScopedRegion(region, isCrossCutting).deepMerge(Json.obj("children" -> children.asJson))
    }

    renderNode(view.target, Set.empty)
  }
}
