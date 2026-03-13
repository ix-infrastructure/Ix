package ix.memory.db

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import java.nio.file.Files

class ArcadeClientSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  private def tempDbResource = {
    val tmpDir = Files.createTempDirectory("arcadedb-test-").toFile.getAbsolutePath
    ArcadeClient.resource(tmpDir)
  }

  "ArcadeClient" should "create and open a database" in {
    tempDbResource.use { client =>
      IO {
        client.raw should not be null
        succeed
      }
    }
  }

  it should "execute a query and return empty results" in {
    tempDbResource.use { client =>
      for {
        _       <- client.ensureSchema()
        results <- client.query("SELECT FROM ix_nodes")
      } yield results shouldBe empty
    }
  }

  it should "execute commands within a transaction" in {
    tempDbResource.use { client =>
      for {
        _ <- client.ensureSchema()
        _ <- client.command(
          "INSERT INTO ix_nodes SET name = :name, kind = :kind",
          Map("name" -> ("testNode": AnyRef), "kind" -> ("function": AnyRef))
        )
        results <- client.query(
          "SELECT FROM ix_nodes WHERE name = :name",
          Map("name" -> ("testNode": AnyRef))
        )
      } yield {
        results.size shouldBe 1
        results.head.hcursor.get[String]("name") shouldBe Right("testNode")
      }
    }
  }

  it should "create all vertex and edge types" in {
    tempDbResource.use { client =>
      for {
        _ <- client.ensureSchema()
      } yield {
        val schema = client.raw.getSchema
        schema.existsType("ix_nodes") shouldBe true
        schema.existsType("ix_edges") shouldBe true
        schema.existsType("ix_claims") shouldBe true
        schema.existsType("ix_patches") shouldBe true
        schema.existsType("ix_revisions") shouldBe true
        schema.existsType("ix_idempotency_keys") shouldBe true
        schema.existsType("ix_conflict_sets") shouldBe true
        schema.existsType("ix_meta") shouldBe true
      }
    }
  }

  it should "have indexes after ensureSchema" in {
    tempDbResource.use { client =>
      for {
        _ <- client.ensureSchema()
      } yield {
        val schema = client.raw.getSchema
        val nodeIndexes = schema.getType("ix_nodes").getAllIndexes(true)
        nodeIndexes.size should be > 0
      }
    }
  }
}
