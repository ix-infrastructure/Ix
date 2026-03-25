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
      edges = Vector.empty,
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
      edges = Vector.empty,
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

  private def region(
    label: String,
    labelKind: String,
    level: Int,
    files: Int,
    confidence: Double = 0.80,
    crosscut: Double = 0.0,
    parent: Option[Region] = None,
  ): Region = {
    val id = NodeId(UUID.randomUUID())
    val memberFiles = (1 to files).map(_ => NodeId(UUID.randomUUID())).toSet
    Region(
      id = id,
      label = label,
      labelKind = labelKind,
      level = level,
      memberFiles = memberFiles,
      childRegionIds = Set.empty,
      parentId = parent.map(_.id),
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
