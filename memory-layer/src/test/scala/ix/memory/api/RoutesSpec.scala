package ix.memory.api

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import io.circe.syntax._
import org.http4s._
import org.http4s.circe.CirceEntityCodec._
import org.http4s.implicits._
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.TestDbHelper
import ix.memory.conflict.ConflictService
import ix.memory.context._
import ix.memory.db._
import ix.memory.ingestion._
import ix.memory.map.MapService
import ix.memory.model._
import ix.memory.smell.SmellService
import ix.memory.subsystem.SubsystemScoringService

class RoutesSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_test_routes", user = "root", password = ""
  )

  private def makePatch(
    baseRev: Rev = Rev(0L),
    ops: Vector[PatchOp] = Vector.empty,
    patchId: PatchId = PatchId(UUID.randomUUID())
  ): GraphPatch =
    GraphPatch(
      patchId   = patchId,
      actor     = "test-actor",
      timestamp = Instant.parse("2025-06-01T12:00:00Z"),
      source    = PatchSource(
        uri        = "test://source",
        sourceHash = Some("hash123"),
        extractor  = "test-extractor",
        sourceType = SourceType.Code
      ),
      baseRev   = baseRev,
      ops       = ops,
      replaces  = Vector.empty,
      intent    = Some("test intent")
    )

  private def buildRoutes(
    client: ArangoClient,
    writeApi: ArangoGraphWriteApi,
    queryApi: ArangoGraphQueryApi
  ): HttpApp[IO] = {
    val conflictService = new ConflictService(client, queryApi, writeApi)
    val contextService = new ContextService(
      queryApi,
      new GraphSeeder(queryApi),
      new GraphExpander(queryApi),
      new ClaimCollector(queryApi),
      new ConfidenceScorerImpl(),
      new ConflictDetectorImpl()
    )
    val parserRouter         = new ParserRouter()
    val ingestionService     = new IngestionService(parserRouter, writeApi, queryApi)
    val bulkWriteApi         = new BulkWriteApi(client)
    val bulkIngestionService = new BulkIngestionService(parserRouter, bulkWriteApi, queryApi)
    val mapService           = new MapService(client, queryApi, writeApi)
    val smellService         = new SmellService(client, writeApi)
    val subsystemService     = new SubsystemScoringService(client, writeApi, mapService)

    Routes.all(
      contextService,
      ingestionService,
      bulkIngestionService,
      queryApi,
      writeApi,
      conflictService,
      client,
      mapService,
      bulkWriteApi,
      smellService,
      subsystemService
    ).orNotFound
  }

  "Routes" should "return 200 OK for health check" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        resp <- app.run(Request[IO](Method.GET, uri"/v1/health"))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[String]("status") shouldBe Right("ok")
      }
    }
  }

  it should "return entity with claims and edges" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "test_func", Map("lang" -> Json.fromString("scala"))),
          PatchOp.AssertClaim(nodeId, "returns", Json.fromString("Int"), Some(0.9))
        )
      )

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        _    <- writeApi.commitPatch(patch)
        resp <- app.run(Request[IO](Method.GET, Uri.unsafeFromString(s"/v1/entity/${nodeId.value}")))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("node").downField("id").as[String] shouldBe Right(nodeId.value.toString)
        body.hcursor.downField("claims").focus.flatMap(_.asArray).map(_.nonEmpty) shouldBe Some(true)
      }
    }
  }

  it should "return empty conflicts list" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        resp <- app.run(Request[IO](Method.GET, uri"/v1/conflicts"))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.asArray.map(_.isEmpty) shouldBe Some(true)
      }
    }
  }

  it should "diff between revisions and detect added entity" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(
        ops = Vector(PatchOp.UpsertNode(nodeId, NodeKind.Function, "diff_func", Map.empty[String, Json]))
      )

      for {
        _      <- client.ensureSchema()
        _      <- cleanDatabase(client)
        result <- writeApi.commitPatch(patch)
        req     = Request[IO](Method.POST, uri"/v1/diff").withEntity(Json.obj(
          "fromRev"  -> 0L.asJson,
          "toRev"    -> result.newRev.value.asJson,
          "entityId" -> nodeId.value.toString.asJson
        ))
        resp   <- app.run(req)
        body   <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        val changes = body.hcursor.downField("changes").focus.flatMap(_.asArray).getOrElse(Vector.empty)
        changes.size shouldBe 1
      }
    }
  }

  it should "return structured context for a query" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "billing_calc", Map.empty[String, Json]),
          PatchOp.AssertClaim(nodeId, "calculates billing", Json.fromString("true"), Some(0.9))
        )
      )

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        _    <- writeApi.commitPatch(patch)
        resp <- app.run(Request[IO](Method.POST, uri"/v1/context").withEntity(Json.obj("query" -> "billing".asJson)))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("metadata").downField("query").as[String] shouldBe Right("billing")
      }
    }
  }

  it should "return provenance chain for entity" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(ops = Vector(PatchOp.UpsertNode(nodeId, NodeKind.Function, "prov_func", Map.empty[String, Json])))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        _    <- writeApi.commitPatch(patch)
        resp <- app.run(Request[IO](Method.POST, Uri.unsafeFromString(s"/v1/provenance/${nodeId.value}")))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("entityId").as[String] shouldBe Right(nodeId.value.toString)
      }
    }
  }

  it should "create a decision node via POST /v1/decide" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        resp <- app.run(Request[IO](Method.POST, uri"/v1/decide").withEntity(Json.obj(
          "title"     -> "Use exponential backoff".asJson,
          "rationale" -> "Better for transient failures".asJson
        )))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[String]("status").toOption shouldBe Some("Ok")
      }
    }
  }

  it should "search nodes by term via POST /v1/search" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(ops = Vector(
        PatchOp.UpsertNode(nodeId, NodeKind.Service, "billing_search_test", Map.empty[String, Json])
      ))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        _    <- writeApi.commitPatch(patch)
        resp <- app.run(Request[IO](Method.POST, uri"/v1/search").withEntity(Json.obj("term" -> "billing_search_test".asJson)))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.asArray should not be empty
      }
    }
  }

  it should "return intent list via GET /v1/truth" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        resp <- app.run(Request[IO](Method.GET, uri"/v1/truth"))
      } yield {
        resp.status shouldBe Status.Ok
      }
    }
  }

  it should "create an intent via POST /v1/truth" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        resp <- app.run(Request[IO](Method.POST, uri"/v1/truth").withEntity(Json.obj(
          "statement" -> "Ship retry system by Friday".asJson
        )))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[String]("status").toOption shouldBe Some("Ok")
      }
    }
  }

  it should "list recent patches via GET /v1/patches" in {
    clientResource.use { client =>
      val app = buildRoutes(client, new ArangoGraphWriteApi(client), new ArangoGraphQueryApi(client))

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        resp <- app.run(Request[IO](Method.GET, uri"/v1/patches"))
      } yield {
        resp.status shouldBe Status.Ok
      }
    }
  }

  it should "return a specific patch by ID via GET /v1/patches/:id" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patchId  = PatchId(UUID.randomUUID())
      val patch    = makePatch(
        patchId = patchId,
        ops = Vector(PatchOp.UpsertNode(nodeId, NodeKind.Function, "patch_test_func", Map.empty[String, Json]))
      )

      for {
        _    <- client.ensureSchema()
        _    <- cleanDatabase(client)
        _    <- writeApi.commitPatch(patch)
        resp <- app.run(Request[IO](Method.GET, Uri.unsafeFromString(s"/v1/patches/${patchId.value}")))
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[String]("patch_id").toOption shouldBe Some(patchId.value.toString)
      }
    }
  }
}
