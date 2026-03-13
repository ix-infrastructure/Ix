package ix.memory

import java.nio.file.{Path, Paths}

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.db._
import ix.memory.ingestion.{IngestionService, ParserRouter}
import ix.memory.model._

/**
 * Integration tests verifying that parser-emitted edges (especially REFERENCES)
 * are persisted and queryable via the expand API.
 *
 * Uses embedded ArcadeDB (no external dependencies).
 */
class QueryUsefulnessSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  private def fixturePath(name: String): Path = {
    val url = getClass.getClassLoader.getResource(s"fixtures/$name")
    Paths.get(url.toURI)
  }

  // ── Scala REFERENCES: object references become query-useful ──

  "QueryUsefulness" should "persist REFERENCES edges from Scala parser and return them via expand" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- service.ingestFile(fixturePath("node_kind.scala"))
        _ <- service.ingestFile(fixturePath("node_kind_user.scala"))

        nodeKindResults <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindEntity = nodeKindResults.find(n => n.name == "NodeKind" && n.kind != NodeKind.Module)

        _ = nodeKindEntity shouldBe defined

        refResult <- queryApi.expand(
          nodeKindEntity.get.id,
          Direction.In,
          predicates = Some(Set("REFERENCES")),
          hops = 1
        )

        _ = refResult.nodes should not be empty
        refNames = refResult.nodes.map(_.name)
        _ = refNames should contain atLeastOneOf ("buildNode", "createNode")
      } yield succeed
    }
  }

  it should "return REFERENCES edges alongside CALLS in combined dependency queries" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- service.ingestFile(fixturePath("node_kind.scala"))
        _ <- service.ingestFile(fixturePath("node_kind_user.scala"))

        nodeKindResults <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindEntity = nodeKindResults.find(n => n.name == "NodeKind" && n.kind != NodeKind.Module)
        _ = nodeKindEntity shouldBe defined

        combinedResult <- queryApi.expand(
          nodeKindEntity.get.id,
          Direction.In,
          predicates = Some(Set("CALLS", "IMPORTS", "REFERENCES")),
          hops = 1
        )

        _ = combinedResult.nodes should not be empty
      } yield succeed
    }
  }

  // ── Scala nested CONTAINS: object membership is queryable ──

  it should "persist nested CONTAINS edges for case objects inside companion" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- service.ingestFile(fixturePath("node_kind.scala"))

        results <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindObj = results.find(n => n.name == "NodeKind" && n.kind == NodeKind.Object)
        _ = nodeKindObj shouldBe defined

        containsResult <- queryApi.expand(
          nodeKindObj.get.id,
          Direction.Out,
          predicates = Some(Set("CONTAINS")),
          hops = 1
        )

        memberNames = containsResult.nodes.map(_.name)
        _ = memberNames should contain allOf ("File", "Module", "Class", "Function", "Method")
      } yield succeed
    }
  }

  // ── TypeScript: file-level CALLS correctness ──

  it should "not create false file-level CALLS for exported function definitions" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- service.ingestFile(fixturePath("command_module.ts"))

        fileResults <- queryApi.searchNodes("command_module.ts", limit = 5, nameOnly = true)
        fileEntity = fileResults.find(n => n.name == "command_module.ts" && n.kind == NodeKind.File)
        _ = fileEntity shouldBe defined

        callsResult <- queryApi.expand(
          fileEntity.get.id,
          Direction.Out,
          predicates = Some(Set("CALLS")),
          hops = 1
        )

        calleeNames = callsResult.nodes.map(_.name)
        _ = calleeNames should not contain ("registerExplainCommand")
      } yield succeed
    }
  }

  // ── TypeScript: cross-file caller attribution ──

  it should "create cross-file CALLS edges for imported function invocations" in {
    tempDbResource.use { client =>
      val writeApi = new ArcadeGraphWriteApi(client)
      val queryApi = new ArcadeGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- client.ensureSchema()
        _ <- service.ingestFile(fixturePath("command_module.ts"))
        _ <- service.ingestFile(fixturePath("command_registration.ts"))

        funcResults <- queryApi.searchNodes("registerExplainCommand", limit = 10, nameOnly = true)
        funcEntity = funcResults.find(n => n.name == "registerExplainCommand" && n.kind == NodeKind.Function)
        _ = funcEntity shouldBe defined

        callersResult <- queryApi.expand(
          funcEntity.get.id,
          Direction.In,
          predicates = Some(Set("CALLS")),
          hops = 1
        )

        callerNames = callersResult.nodes.map(_.name)
        _ = callerNames should contain ("command_registration.ts")
        _ = callerNames should not contain ("command_module.ts")
      } yield succeed
    }
  }
}
