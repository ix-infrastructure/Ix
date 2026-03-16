package ix.memory.db

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.Json

class ArangoClientSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  // Requires ArangoDB running on localhost:8529
  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_test_arango_client", user = "root", password = ""
  )

  "ArangoClient" should "connect and ensure schema" in {
    clientResource.use { client =>
      client.ensureSchema().map(_ => succeed)
    }
  }

  it should "execute a simple query" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        results <- client.query("RETURN 1", Map.empty)
      } yield results.size shouldBe 1
    }
  }

  it should "insert and retrieve a document" in {
    clientResource.use { client =>
      for {
        _ <- client.ensureSchema()
        // Clean up any leftover document from previous runs
        _ <- client.execute(
          "FOR n IN nodes FILTER n._key == @key REMOVE n IN nodes",
          Map("key" -> "test1")
        )
        _ <- client.execute(
          "INSERT { _key: @key, name: @name } INTO nodes",
          Map("key" -> "test1", "name" -> "testNode")
        )
        result <- client.queryOne(
          "FOR n IN nodes FILTER n._key == @key RETURN n",
          Map("key" -> "test1")
        )
      } yield {
        result shouldBe defined
        result.get.hcursor.get[String]("name") shouldBe Right("testNode")
      }
    }
  }
}
