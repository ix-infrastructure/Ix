package ix.memory.model

import java.time.Instant
import java.util.UUID

import io.circe._
import io.circe.parser._
import io.circe.syntax._
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class ModelSpec extends AnyFlatSpec with Matchers {

  // ── Identifiers round-trip ──────────────────────────────────────────

  "Identifiers" should "round-trip NodeId through JSON" in {
    val id = NodeId(UUID.randomUUID())
    decode[NodeId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip EdgeId through JSON" in {
    val id = EdgeId(UUID.randomUUID())
    decode[EdgeId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip PatchId through JSON" in {
    val id = PatchId(UUID.randomUUID())
    decode[PatchId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip ClaimId through JSON" in {
    val id = ClaimId(UUID.randomUUID())
    decode[ClaimId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip ConflictId through JSON" in {
    val id = ConflictId(UUID.randomUUID())
    decode[ConflictId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip TenantId through JSON" in {
    val id = TenantId(UUID.randomUUID())
    decode[TenantId](id.asJson.noSpaces) shouldBe Right(id)
  }

  it should "round-trip Rev through JSON" in {
    val rev = Rev(42L)
    decode[Rev](rev.asJson.noSpaces) shouldBe Right(rev)
  }

  // ── SourceType ──────────────────────────────────────────────────────

  "SourceType" should "encode and decode all variants correctly" in {
    val variants: List[SourceType] = List(
      SourceType.Code,
      SourceType.Config,
      SourceType.Doc,
      SourceType.Test,
      SourceType.Schema,
      SourceType.Commit,
      SourceType.Comment,
      SourceType.Inferred,
      SourceType.Human
    )

    variants.foreach { st =>
      val json = st.asJson
      json.isString shouldBe true
      decode[SourceType](json.noSpaces) shouldBe Right(st)
    }
  }

  // ── NodeKind ────────────────────────────────────────────────────────

  "NodeKind" should "encode and decode all variants correctly" in {
    val variants: List[NodeKind] = List(
      NodeKind.Module,
      NodeKind.File,
      NodeKind.Class,
      NodeKind.Function,
      NodeKind.Variable,
      NodeKind.Config,
      NodeKind.ConfigEntry,
      NodeKind.Service,
      NodeKind.Endpoint
    )

    variants.foreach { nk =>
      val json = nk.asJson
      json.isString shouldBe true
      decode[NodeKind](json.noSpaces) shouldBe Right(nk)
    }
  }

  // ── ClaimStatus ─────────────────────────────────────────────────────

  "ClaimStatus" should "encode and decode all variants" in {
    val variants: List[ClaimStatus] = List(
      ClaimStatus.Active,
      ClaimStatus.Stale,
      ClaimStatus.Retracted
    )

    variants.foreach { cs =>
      val json = cs.asJson
      json.isString shouldBe true
      decode[ClaimStatus](json.noSpaces) shouldBe Right(cs)
    }
  }

  // ── Provenance round-trip ───────────────────────────────────────────

  "Provenance" should "round-trip through JSON" in {
    val prov = Provenance(
      sourceUri    = "git://repo/file.scala",
      sourceHash   = "abc123",
      extractor    = "tree-sitter",
      sourceType   = SourceType.Code,
      observedAt   = Instant.parse("2025-01-01T00:00:00Z")
    )

    val json = prov.asJson
    val decoded = decode[Provenance](json.noSpaces)
    decoded shouldBe Right(prov)
  }

  // ── GraphPatch serialization ────────────────────────────────────────

  "GraphPatch" should "serialize with all fields" in {
    val tenantId = TenantId(UUID.randomUUID())
    val patchId  = PatchId(UUID.randomUUID())
    val nodeId   = NodeId(UUID.randomUUID())
    val edgeId   = EdgeId(UUID.randomUUID())
    val claimId  = ClaimId(UUID.randomUUID())

    val prov = Provenance(
      sourceUri  = "git://repo/file.scala",
      sourceHash = "def456",
      extractor  = "tree-sitter",
      sourceType = SourceType.Code,
      observedAt = Instant.parse("2025-06-01T12:00:00Z")
    )

    val ops: List[PatchOp] = List(
      PatchOp.UpsertNode(
        GraphNode(
          id         = nodeId,
          kind       = NodeKind.Function,
          tenant     = tenantId,
          attrs      = Json.obj("name" -> Json.fromString("foo")),
          provenance = prov,
          createdRev = Rev(1L),
          deletedRev = None,
          createdAt  = Instant.parse("2025-06-01T12:00:00Z"),
          updatedAt  = Instant.parse("2025-06-01T12:00:00Z")
        )
      ),
      PatchOp.UpsertEdge(
        GraphEdge(
          id         = edgeId,
          src        = nodeId,
          dst        = NodeId(UUID.randomUUID()),
          predicate  = EdgePredicate("CALLS"),
          tenant     = tenantId,
          attrs      = Json.obj(),
          provenance = prov,
          createdRev = Rev(1L),
          deletedRev = None
        )
      ),
      PatchOp.DeleteNode(nodeId),
      PatchOp.DeleteEdge(edgeId),
      PatchOp.AssertClaim(
        Claim(
          id         = claimId,
          entityId   = nodeId.value,
          statement  = "function foo is pure",
          status     = ClaimStatus.Active,
          provenance = prov,
          createdRev = Rev(1L),
          deletedRev = None
        )
      ),
      PatchOp.RetractClaim(claimId)
    )

    val patch = GraphPatch(
      patchId   = patchId,
      tenant    = tenantId,
      actor     = "extractor:tree-sitter",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = PatchSource(uri = "git://repo", ref = Some("main")),
      baseRev   = Rev(0L),
      ops       = ops,
      replaces  = None,
      intent    = Some("initial extraction")
    )

    val json    = patch.asJson
    val decoded = decode[GraphPatch](json.noSpaces)
    decoded shouldBe Right(patch)

    // Verify all top-level fields are present
    val cursor = json.hcursor
    cursor.downField("patchId").succeeded shouldBe true
    cursor.downField("tenant").succeeded shouldBe true
    cursor.downField("actor").succeeded shouldBe true
    cursor.downField("timestamp").succeeded shouldBe true
    cursor.downField("source").succeeded shouldBe true
    cursor.downField("baseRev").succeeded shouldBe true
    cursor.downField("ops").succeeded shouldBe true
    cursor.downField("intent").succeeded shouldBe true
  }

  // ── ConfidenceBreakdown.score ───────────────────────────────────────

  "ConfidenceBreakdown" should "compute score correctly: 0.90 * 1.1 * 1.0 * 1.1 * 0.85 = ~0.926" in {
    val breakdown = ConfidenceBreakdown(
      baseAuthority   = Factor(0.90, "code source"),
      verification    = Factor(1.1, "test-verified"),
      recency         = Factor(1.0, "recent commit"),
      corroboration   = Factor(1.1, "multiple extractors agree"),
      conflictPenalty = Factor(0.85, "minor conflict")
    )

    // 0.90 * 1.1 * 1.0 * 1.1 * 0.85 = 0.92565
    breakdown.score shouldBe 0.926 +- 0.001
  }

  it should "clamp score to 1.0 when product exceeds 1.0" in {
    val breakdown = ConfidenceBreakdown(
      baseAuthority   = Factor(1.0, "max"),
      verification    = Factor(1.5, "highly verified"),
      recency         = Factor(1.0, "fresh"),
      corroboration   = Factor(1.5, "strong agreement"),
      conflictPenalty = Factor(1.0, "no conflict")
    )

    breakdown.score shouldBe 1.0
  }

  it should "clamp score to 0.0 when product is negative" in {
    val breakdown = ConfidenceBreakdown(
      baseAuthority   = Factor(0.0, "unknown"),
      verification    = Factor(1.0, "none"),
      recency         = Factor(1.0, "none"),
      corroboration   = Factor(1.0, "none"),
      conflictPenalty = Factor(1.0, "none")
    )

    breakdown.score shouldBe 0.0
  }

  it should "round-trip through JSON" in {
    val breakdown = ConfidenceBreakdown(
      baseAuthority   = Factor(0.90, "code source"),
      verification    = Factor(1.1, "test-verified"),
      recency         = Factor(1.0, "recent commit"),
      corroboration   = Factor(1.1, "multiple extractors agree"),
      conflictPenalty = Factor(0.85, "minor conflict")
    )

    val json    = breakdown.asJson
    val decoded = decode[ConfidenceBreakdown](json.noSpaces)
    decoded shouldBe Right(breakdown)
  }
}
