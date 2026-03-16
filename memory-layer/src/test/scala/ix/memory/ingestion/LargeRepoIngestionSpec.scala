package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.TestDbHelper
import ix.memory.db.{ArangoClient, ArangoGraphQueryApi, BulkWriteApi}

class LargeRepoIngestionSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_test_large_repo", user = "root", password = ""
  )

  private def createSyntheticRepo(fileCount: Int): IO[Path] = IO.blocking {
    val tmpDir = Files.createTempDirectory("ix-large-repo-test")
    for (i <- 0 until fileCount) {
      val subDir = tmpDir.resolve(s"pkg${i / 100}")
      Files.createDirectories(subDir)
      val content = s"class Service$i:\n    def process(self):\n        return $i\n"
      Files.writeString(subDir.resolve(s"service_$i.py"), content)
    }
    // Create one oversized file to test the size guard
    val bigFile = tmpDir.resolve("huge_generated.py")
    val bigContent = "x" * (1024 * 1024 + 1) // Just over 1MB
    Files.writeString(bigFile, bigContent)
    tmpDir
  }

  private def cleanupDir(dir: Path): IO[Unit] = IO.blocking {
    import scala.jdk.CollectionConverters._
    Files.walk(dir).iterator().asScala.toList.sortBy(_.toString).reverse.foreach(Files.deleteIfExists)
  }

  "BulkIngestionService" should "handle 500 files without OOM" in {
    clientResource.use { client =>
      val queryApi = new ArangoGraphQueryApi(client)
      val writeApi = new BulkWriteApi(client)
      val router   = new ParserRouter()
      val service  = new BulkIngestionService(router, writeApi, queryApi)

      for {
        _      <- client.ensureSchema()
        _      <- cleanDatabase(client)
        tmpDir <- createSyntheticRepo(500)
        result <- service.ingestPath(tmpDir, Some("python"), recursive = true)
        _      <- cleanupDir(tmpDir)
      } yield {
        result.filesProcessed should be >= 500
        result.patchesApplied should be >= 500
        result.skipReasons.tooLarge shouldBe 1 // the oversized file
        result.skipReasons.parseError shouldBe 0
      }
    }
  }

  it should "produce correct skip reasons on re-ingest" in {
    clientResource.use { client =>
      val queryApi = new ArangoGraphQueryApi(client)
      val writeApi = new BulkWriteApi(client)
      val router   = new ParserRouter()
      val service  = new BulkIngestionService(router, writeApi, queryApi)

      for {
        _      <- client.ensureSchema()
        _      <- cleanDatabase(client)
        tmpDir <- createSyntheticRepo(10)
        r1     <- service.ingestPath(tmpDir, Some("python"), recursive = true)
        r2     <- service.ingestPath(tmpDir, Some("python"), recursive = true)
        _      <- cleanupDir(tmpDir)
      } yield {
        r1.patchesApplied should be >= 10
        r2.patchesApplied shouldBe 0
        r2.skipReasons.unchanged should be >= 10
      }
    }
  }

  it should "survive chunked writes on medium batch" in {
    clientResource.use { client =>
      val queryApi = new ArangoGraphQueryApi(client)
      val writeApi = new BulkWriteApi(client)
      val router   = new ParserRouter()
      val service  = new BulkIngestionService(router, writeApi, queryApi)

      for {
        _      <- client.ensureSchema()
        _      <- cleanDatabase(client)
        tmpDir <- createSyntheticRepo(250)
        result <- service.ingestPath(tmpDir, Some("python"), recursive = true)
        rev    <- queryApi.getLatestRev
        _      <- cleanupDir(tmpDir)
      } yield {
        result.patchesApplied should be >= 250
        rev.value should be > 0L
      }
    }
  }
}
