package ix.memory.context

import java.nio.file.{Files, Path}
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import io.circe.Json
import ix.memory.model._

class StalenessDetectorSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def hashOf(content: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(content.getBytes("UTF-8"))
      .map("%02x".format(_))
      .mkString

  private def makeClaim(sourceUri: String, sourceHash: Option[String]): Claim =
    Claim(
      id         = ClaimId(UUID.randomUUID()),
      entityId   = NodeId(UUID.randomUUID()),
      statement  = "test claim",
      value      = Json.Null,
      confidence = None,
      status     = ClaimStatus.Active,
      provenance = Provenance(sourceUri, sourceHash, "test", SourceType.Code, Instant.now()),
      createdRev = Rev(1L),
      deletedRev = None
    )

  // Test 1: File unchanged -- not stale
  "StalenessDetector" should "return false when file hash matches" in {
    val tmpFile = Files.createTempFile("staleness-test-", ".txt")
    Files.writeString(tmpFile, "hello world")
    val hash = hashOf("hello world")
    val claim = makeClaim(tmpFile.toString, Some(hash))

    StalenessDetector.detect(Vector(claim)).map { result =>
      result(claim.id) shouldBe false
      Files.deleteIfExists(tmpFile)
      succeed
    }
  }

  // Test 2: File changed -- stale
  it should "return true when file hash differs" in {
    val tmpFile = Files.createTempFile("staleness-test-", ".txt")
    Files.writeString(tmpFile, "updated content")
    val oldHash = hashOf("original content")
    val claim = makeClaim(tmpFile.toString, Some(oldHash))

    StalenessDetector.detect(Vector(claim)).map { result =>
      result(claim.id) shouldBe true
      Files.deleteIfExists(tmpFile)
      succeed
    }
  }

  // Test 3: File doesn't exist -- stale
  it should "return true when file no longer exists" in {
    val claim = makeClaim("/nonexistent/path/to/file.py", Some("abc123"))

    StalenessDetector.detect(Vector(claim)).map { result =>
      result(claim.id) shouldBe true
    }
  }

  // Test 4: No source hash recorded -- treat as fresh
  it should "return false when no source hash is recorded" in {
    val claim = makeClaim("/some/path.py", None)

    StalenessDetector.detect(Vector(claim)).map { result =>
      result(claim.id) shouldBe false
    }
  }

  // Test 5: Multiple claims from same file -- efficient (single hash)
  it should "handle multiple claims from the same source efficiently" in {
    val tmpFile = Files.createTempFile("staleness-test-", ".txt")
    Files.writeString(tmpFile, "content")
    val hash = hashOf("content")
    val c1 = makeClaim(tmpFile.toString, Some(hash))
    val c2 = makeClaim(tmpFile.toString, Some(hash))

    StalenessDetector.detect(Vector(c1, c2)).map { result =>
      result(c1.id) shouldBe false
      result(c2.id) shouldBe false
      Files.deleteIfExists(tmpFile)
      succeed
    }
  }

  // Test 6: Empty claims
  it should "return empty map for no claims" in {
    StalenessDetector.detect(Vector.empty).map { result =>
      result shouldBe empty
    }
  }

  // Test 7: Mix of stale and fresh
  it should "handle mix of stale and fresh claims" in {
    val tmpFile = Files.createTempFile("staleness-test-", ".txt")
    Files.writeString(tmpFile, "current content")
    val correctHash = hashOf("current content")
    val wrongHash = hashOf("old content")

    val fresh = makeClaim(tmpFile.toString, Some(correctHash))
    val stale = makeClaim(tmpFile.toString, Some(wrongHash))

    StalenessDetector.detect(Vector(fresh, stale)).map { result =>
      result(fresh.id) shouldBe false
      result(stale.id) shouldBe true
      Files.deleteIfExists(tmpFile)
      succeed
    }
  }
}
