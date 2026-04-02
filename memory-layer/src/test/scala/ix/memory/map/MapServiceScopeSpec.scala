package ix.memory.map

import java.util.UUID

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model.NodeId

class MapServiceScopeSpec extends AnyFlatSpec with Matchers {

  private val service = new MapService(null, null, null)

  "resolveRegion" should "order ambiguous matches by match quality, level preference, and significance" in {
    val context = region("Context", "system", 3, files = 120)
    val apiSubsystem = region("Api", "subsystem", 2, files = 35, parent = Some(context))
    val apiModule = region("Api", "module", 1, files = 12, parent = Some(context))
    val apiClient = region("Api / Client", "system", 3, files = 90)

    val map = ArchitectureMap(
      regions = Vector(context, apiSubsystem, apiModule, apiClient),

      fileCount = 257,
      mapRev = 42L
    )

    val matches = service.resolveRegion(map, "api")

    matches.map(_.region.label) shouldBe Vector("Api", "Api", "Api / Client")
    matches.map(_.region.labelKind) shouldBe Vector("subsystem", "module", "system")
  }

  "scopedView" should "summarize subtree health while returning only direct children" in {
    val system = region("Cli", "system", 3, files = 140, confidence = 0.82)
    val subsystem = region("Cli / Client", "subsystem", 2, files = 105, confidence = 0.72, parent = Some(system))
    val moduleA = region("Cli / Client", "module", 1, files = 53, confidence = 0.91, parent = Some(subsystem))
    val moduleB = region("Queries", "module", 1, files = 10, confidence = 0.42, crosscut = 0.18, parent = Some(subsystem))
    val moduleC = region("Github", "module", 1, files = 22, confidence = 0.63, parent = Some(subsystem))

    val map = ArchitectureMap(
      regions = Vector(system, subsystem, moduleA, moduleB, moduleC),

      fileCount = 140,
      mapRev = 42L
    )

    val view = service.scopedView(map, subsystem)

    view.parent.map(_.label) shouldBe Some("Cli")
    view.children.map(_.label) shouldBe Vector("Cli / Client", "Github", "Queries")
    view.summary.wellDefined shouldBe 1
    view.summary.moderate shouldBe 2
    view.summary.fuzzy shouldBe 1
    view.summary.crossCutting shouldBe 1
  }

  "collapseDuplicateHierarchyLevels" should "keep only the coarsest region for repeated member sets" in {
    val sharedId = NodeId(UUID.randomUUID())
    val sharedFiles = (1 to 10).map(_ => NodeId(UUID.randomUUID())).toSet
    val child = region("Edges / Resolver", "module", 1, files = 4, parentId = Some(sharedId))
    val module = regionWithMembers("Edges", "module", 1, sharedId, sharedFiles)
    val subsystem = regionWithMembers("Edges", "subsystem", 2, sharedId, sharedFiles)
    val system = regionWithMembers("Edges", "system", 3, sharedId, sharedFiles)

    val collapsed = service.collapseDuplicateHierarchyLevels(Vector(child, module, subsystem, system))

    collapsed.map(region => region.label -> region.labelKind) shouldBe Vector(
      "Edges / Resolver" -> "module",
      "Edges" -> "system"
    )
    collapsed.map(_.id) should contain (sharedId)
    collapsed.find(_.label == "Edges / Resolver").flatMap(_.parentId) shouldBe Some(sharedId)
  }

  "appendSingletonRegionsForUncoveredFiles" should "create module regions for files left out by clustering" in {
    val fileA = fileVertex("C:/repo/src/core/service.ts")
    val fileB = fileVertex("C:/repo/infra/Dockerfile")
    val graph = WeightedFileGraph(
      vertices = Vector(fileA, fileB),
      adjMatrix = Map(fileA.id -> Map.empty, fileB.id -> Map.empty),
      degrees = Map(fileA.id -> 0.0, fileB.id -> 0.0),
      totalWeight = 0.0,
      predicatePairs = Map.empty
    )
    val existing = regionWithMembers("Core", "module", 1, NodeId(UUID.randomUUID()), Set(fileA.id))

    val completed = service.appendSingletonRegionsForUncoveredFiles(
      regions = Vector(existing),
      graph = graph,
      fileVertexById = graph.vertices.map(v => v.id -> v).toMap,
      crosscutScores = Map.empty,
      signalAdjacency = Map.empty,
      rev = ix.memory.model.Rev(42L)
    )

    completed.map(_.memberFiles) should contain (Set(fileB.id))
    completed.find(_.memberFiles == Set(fileB.id)).map(_.labelKind) shouldBe Some("module")
  }

  it should "emit exactly one edge when a file belongs to multiple level-1 regions" in {
    val file = NodeId(UUID.randomUUID())
    val moduleId    = NodeId(UUID.randomUUID())
    val subsystemId = NodeId(UUID.randomUUID())

    // Both regions are level 1 — old code emitted two IN_REGION edges; new code emits one.
    val moduleRegion    = regionWithMembers("Lib", "module",    1, moduleId,    Set(file))
    val subsystemRegion = regionWithMembers("Lib", "subsystem", 1, subsystemId, Set(file))

    val edgeDocs = service.buildRegionEdgeDocs(
      regions = Vector(moduleRegion, subsystemRegion),
      newRev  = 42L,
      now     = "2026-04-01T00:00:00Z",
      provMap = new java.util.HashMap[String, AnyRef]()
    )

    val fileEdges = edgeDocs.filter(_.get("dst").toString == file.value.toString)

    // Exactly one edge — no duplicates from the two level-1 regions.
    fileEdges should have length 1
    // "module" sorts before "subsystem" so the module region wins.
    fileEdges.head.get("src").toString shouldBe moduleId.value.toString
  }

  "buildRegionEdgeDocs" should "attach files to their most specific surviving region" in {
    val fileA = NodeId(UUID.randomUUID())
    val fileB = NodeId(UUID.randomUUID())
    val sharedRegionId = NodeId(UUID.randomUUID())
    val childRegionId = NodeId(UUID.randomUUID())
    val systemRegionId = NodeId(UUID.randomUUID())

    val module = regionWithMembers("Dist", "module", 1, childRegionId, Set(fileA))
    val system = regionWithMembers("Countries", "system", 2, systemRegionId, Set(fileA, fileB))
    val collapsedSystem = regionWithMembers("Countries", "system", 2, sharedRegionId, Set(fileA))

    val edgeDocs = service.buildRegionEdgeDocs(
      regions = Vector(system, collapsedSystem, module),
      newRev = 42L,
      now = "2026-04-01T00:00:00Z",
      provMap = new java.util.HashMap[String, AnyRef]()
    )

    val fileEdges = edgeDocs.filter { doc =>
      val dst = doc.get("dst").toString
      dst == fileA.value.toString || dst == fileB.value.toString
    }
    val fileEdgeByDst = fileEdges.map(doc => doc.get("dst").toString -> doc.get("src").toString).toMap

    fileEdgeByDst(fileA.value.toString) shouldBe childRegionId.value.toString
    fileEdgeByDst(fileB.value.toString) shouldBe systemRegionId.value.toString
  }

  private def fileVertex(path: String): FileVertex =
    FileVertex(NodeId(UUID.randomUUID()), path)

  private def region(
    label: String,
    labelKind: String,
    level: Int,
    files: Int,
    confidence: Double = 0.80,
    crosscut: Double = 0.0,
    parent: Option[Region] = None,
    parentId: Option[NodeId] = None,
  ): Region = {
    regionWithMembers(label, labelKind, level, NodeId(UUID.randomUUID()), (1 to files).map(_ => NodeId(UUID.randomUUID())).toSet, confidence, crosscut, parent.map(_.id).orElse(parentId))
  }

  private def regionWithMembers(
    label: String,
    labelKind: String,
    level: Int,
    id: NodeId,
    memberFiles: Set[NodeId],
    confidence: Double = 0.80,
    crosscut: Double = 0.0,
    parentId: Option[NodeId] = None,
  ): Region = {
    Region(
      id = id,
      label = label,
      labelKind = labelKind,
      level = level,
      memberFiles = memberFiles,
      childRegionIds = Set.empty,
      parentId = parentId,
      cohesion = 0.5,
      externalCoupling = 0.2,
      boundaryRatio = 1.5,
      confidence = confidence,
      crosscutScore = crosscut,
      dominantSignals = List("calls", "imports"),
      interfaceNodeCount = 1,
      mapRev = 42L
    )
  }
}
