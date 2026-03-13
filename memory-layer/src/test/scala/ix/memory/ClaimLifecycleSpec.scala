package ix.memory

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.db._
import ix.memory.model._

class ClaimLifecycleSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  private val testEntityId = NodeId(UUID.nameUUIDFromBytes("test:entity1".getBytes("UTF-8")))

  private def makePatch(
    baseRev: Rev = Rev(0L),
    ops: Vector[PatchOp] = Vector.empty,
    patchId: PatchId = PatchId(UUID.randomUUID()),
    source: PatchSource = PatchSource("file:///tmp/test.md", Some("hash1"), "markdown-parser/1.0", SourceType.Doc)
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = source,
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  // ── Test 1: Claim Retirement ─────────────────────────────────────────

  "ClaimLifecycle" should "retire old claims when a new value is asserted for the same field" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)

      for {
        _ <- client.ensureSchema()

        // Step 1: Create node + assert initial content claim
        patch1 = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "content", Json.fromString("hello"), None)
          )
        )
        commit1 <- writeApi.commitPatch(patch1)

        // Verify initial claim exists
        claimsBefore <- queryApi.getClaims(testEntityId)
        _ = {
          commit1.status shouldBe CommitStatus.Ok
          claimsBefore.count(_.status == ClaimStatus.Active) should be >= 1
          claimsBefore.exists(_.statement == "content") shouldBe true
        }

        // Step 2: Re-ingest with changed content
        patch2 = makePatch(
          baseRev = commit1.newRev,
          source = PatchSource("file:///tmp/test.md", Some("hash2"), "markdown-parser/1.0", SourceType.Doc),
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "content", Json.fromString("zzzxqv123"), None)
          )
        )
        commit2 <- writeApi.commitPatch(patch2)

        // Verify: only one active content claim, old one is retracted
        claimsAfter <- queryApi.getClaims(testEntityId)
      } yield {
        commit2.status shouldBe CommitStatus.Ok

        // Only one active content claim
        val activeContentClaims = claimsAfter.filter(c => c.statement == "content" && c.status == ClaimStatus.Active)
        activeContentClaims.size shouldBe 1

        // The old claim should be retired (not returned by getClaims which filters deleted_rev == null)
        // But we can check that no stale content claims exist in active state
        claimsAfter.count(c => c.statement == "content" && c.status == ClaimStatus.Active) shouldBe 1
      }
    }
  }

  // ── Test 2: Search Coverage ──────────────────────────────────────────

  it should "find entities by name, provenance, claim field, and claim value" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)

      for {
        _ <- client.ensureSchema()

        // Ingest a doc node with claims
        patch = makePatch(
          source = PatchSource("file:///projects/readme.md", Some("abc"), "markdown-parser/1.0", SourceType.Doc),
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "readme.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "language", Json.fromString("markdown"), None),
            PatchOp.AssertClaim(testEntityId, "content", Json.fromString("This is a test document about billing"), None)
          )
        )
        commit <- writeApi.commitPatch(patch)
        _ = commit.status shouldBe CommitStatus.Ok

        // Search by node name
        byName <- queryApi.searchNodes("readme")
        // Search by provenance (source_uri)
        byProvenance <- queryApi.searchNodes("/projects/readme")
        // Search by claim field
        byField <- queryApi.searchNodes("language")
        // Search by claim value
        byValue <- queryApi.searchNodes("markdown")
        // Search by content
        byContent <- queryApi.searchNodes("billing")
      } yield {
        byName should not be empty
        byName.head.id shouldBe testEntityId

        byProvenance should not be empty
        byProvenance.head.id shouldBe testEntityId

        byField should not be empty
        byField.head.id shouldBe testEntityId

        byValue should not be empty
        byValue.head.id shouldBe testEntityId

        byContent should not be empty
        byContent.head.id shouldBe testEntityId
      }
    }
  }

  // ── Test 3: Identical Claim Dedup ────────────────────────────────────

  it should "not create duplicate active claims when the same claim is asserted twice" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)

      for {
        _ <- client.ensureSchema()

        // Step 1: Assert a claim
        patch1 = makePatch(
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "language", Json.fromString("markdown"), None)
          )
        )
        commit1 <- writeApi.commitPatch(patch1)

        claimsBefore <- queryApi.getClaims(testEntityId)
        langClaimsBefore = claimsBefore.count(c => c.statement == "language" && c.status == ClaimStatus.Active)

        // Step 2: Assert the exact same claim again
        patch2 = makePatch(
          baseRev = commit1.newRev,
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "language", Json.fromString("markdown"), None)
          )
        )
        commit2 <- writeApi.commitPatch(patch2)

        claimsAfter <- queryApi.getClaims(testEntityId)
        langClaimsAfter = claimsAfter.count(c => c.statement == "language" && c.status == ClaimStatus.Active)
      } yield {
        commit1.status shouldBe CommitStatus.Ok
        commit2.status shouldBe CommitStatus.Ok

        // Should have exactly one active language claim, not two
        langClaimsBefore shouldBe 1
        langClaimsAfter shouldBe 1
      }
    }
  }

  // ── Test 4: Absent Claims Retirement ─────────────────────────────────

  it should "retire claims from the same extractor that are no longer emitted" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)

      for {
        _ <- client.ensureSchema()

        // Step 1: Assert two claims from the same extractor
        patch1 = makePatch(
          source = PatchSource("file:///tmp/test.md", Some("hash1"), "markdown-parser/1.0", SourceType.Doc),
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "language", Json.fromString("markdown"), None),
            PatchOp.AssertClaim(testEntityId, "content", Json.fromString("hello world"), None)
          )
        )
        commit1 <- writeApi.commitPatch(patch1)

        claimsBefore <- queryApi.getClaims(testEntityId)
        _ = {
          claimsBefore.count(_.status == ClaimStatus.Active) shouldBe 2
        }

        // Step 2: Re-ingest from same extractor but only emit "language" (content is absent)
        patch2 = makePatch(
          baseRev = commit1.newRev,
          source = PatchSource("file:///tmp/test.md", Some("hash2"), "markdown-parser/1.0", SourceType.Doc),
          ops = Vector(
            PatchOp.UpsertNode(testEntityId, NodeKind.Doc, "test.md", Map.empty[String, Json]),
            PatchOp.AssertClaim(testEntityId, "language", Json.fromString("markdown"), None)
          )
        )
        commit2 <- writeApi.commitPatch(patch2)

        claimsAfter <- queryApi.getClaims(testEntityId)
      } yield {
        commit2.status shouldBe CommitStatus.Ok

        // Only "language" should remain active; "content" should be retired
        val activeClaims = claimsAfter.filter(_.status == ClaimStatus.Active)
        activeClaims.size shouldBe 1
        activeClaims.head.statement shouldBe "language"
      }
    }
  }
}
