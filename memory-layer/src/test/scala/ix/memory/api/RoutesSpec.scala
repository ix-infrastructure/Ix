package ix.memory.api

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import io.circe.Json
import io.circe.syntax._
import org.http4s._
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._
import org.http4s.implicits._
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.conflict.ConflictService
import ix.memory.context._
import ix.memory.db._
import ix.memory.ingestion.{IngestionService, ParserRouter}
import ix.memory.model._

class RoutesSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_memory_test", user = "root", password = ""
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
    val ingestionService = new IngestionService(new ParserRouter(), writeApi)
    Routes.all(contextService, ingestionService, queryApi, conflictService, client).orNotFound
  }

  // ── Test 1: Health check ─────────────────────────────────────────────

  "Routes" should "return 200 OK for health check" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app = buildRoutes(client, writeApi, queryApi)
      val req = Request[IO](Method.GET, uri"/v1/health")

      for {
        resp <- app.run(req)
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[String]("status") shouldBe Right("ok")
      }
    }
  }

  // ── Test 2: GET /v1/entity/:id returns entity with claims ────────────

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
        _    <- writeApi.commitPatch(patch)
        req   = Request[IO](Method.GET, Uri.unsafeFromString(s"/v1/entity/${nodeId.value}"))
        resp <- app.run(req)
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("node").downField("id").as[String] shouldBe Right(nodeId.value.toString)
        body.hcursor.downField("claims").focus.flatMap(_.asArray).map(_.nonEmpty) shouldBe Some(true)
      }
    }
  }

  // ── Test 3: GET /v1/entity/:id returns 404 for missing entity ────────

  it should "return 404 for missing entity" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val fakeId   = UUID.randomUUID()

      for {
        _    <- client.ensureSchema()
        req   = Request[IO](Method.GET, Uri.unsafeFromString(s"/v1/entity/$fakeId"))
        resp <- app.run(req)
      } yield {
        resp.status shouldBe Status.NotFound
      }
    }
  }

  // ── Test 4: GET /v1/conflicts returns empty list ─────────────────────

  it should "return empty conflicts list" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)

      for {
        _    <- client.ensureSchema()
        req   = Request[IO](Method.GET, Uri.unsafeFromString(s"/v1/conflicts"))
        resp <- app.run(req)
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.asArray.map(_.isEmpty) shouldBe Some(true)
      }
    }
  }

  // ── Test 5: POST /v1/diff returns diff between revisions ─────────────

  it should "diff between revisions and detect added entity" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "diff_func", Map.empty[String, Json])
        )
      )

      for {
        _      <- client.ensureSchema()
        result <- writeApi.commitPatch(patch)
        diffReq = Json.obj(
          "fromRev"  -> 0L.asJson,
          "toRev"    -> result.newRev.value.asJson,
          "entityId" -> nodeId.value.toString.asJson
        )
        req     = Request[IO](Method.POST, uri"/v1/diff").withEntity(diffReq)
        resp   <- app.run(req)
        body   <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        val changes = body.hcursor.downField("changes").focus.flatMap(_.asArray).getOrElse(Vector.empty)
        changes.size shouldBe 1
        changes.head.hcursor.get[String]("changeType") shouldBe Right("added")
      }
    }
  }

  // ── Test 6: POST /v1/diff returns 400 for invalid rev order ──────────

  it should "return 400 for invalid rev order in diff" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)

      for {
        _    <- client.ensureSchema()
        diffReq = Json.obj(
          "fromRev" -> 5L.asJson,
          "toRev"   -> 2L.asJson
        )
        req   = Request[IO](Method.POST, uri"/v1/diff").withEntity(diffReq)
        resp <- app.run(req)
      } yield {
        resp.status shouldBe Status.BadRequest
      }
    }
  }

  // ── Test 7: POST /v1/context returns structured context ──────────────

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
        _    <- writeApi.commitPatch(patch)
        ctxReq = Json.obj(
          "query"  -> "billing".asJson
        )
        req   = Request[IO](Method.POST, uri"/v1/context").withEntity(ctxReq)
        resp <- app.run(req)
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("metadata").downField("query").as[String] shouldBe Right("billing")
      }
    }
  }

  // ── Test 8: POST /v1/ingest ingests a Python file ─────────────────────

  it should "ingest a Python file and return counts" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)

      for {
        _       <- client.ensureSchema()
        tmpFile <- IO.blocking {
          val f = java.nio.file.Files.createTempFile("ix-test-", ".py")
          java.nio.file.Files.writeString(f,
            """def hello():
              |    return "world"
              |""".stripMargin
          )
          f
        }
        ingestReq = Json.obj(
          "path"   -> tmpFile.toAbsolutePath.toString.asJson
        )
        req     = Request[IO](Method.POST, uri"/v1/ingest").withEntity(ingestReq)
        resp   <- app.run(req)
        body   <- resp.as[Json]
        _      <- IO.blocking(java.nio.file.Files.deleteIfExists(tmpFile))
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.get[Int]("filesProcessed").toOption should not be empty
        body.hcursor.get[Int]("patchesApplied").toOption should not be empty
        body.hcursor.get[Long]("latestRev").toOption should not be empty
      }
    }
  }

  // ── Test 9: POST /v1/ingest rejects path traversal ────────────────

  it should "return 400 for path traversal attempt" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)

      for {
        _    <- client.ensureSchema()
        ingestReq = Json.obj(
          "path"   -> "/tmp/../etc/passwd".asJson
        )
        req   = Request[IO](Method.POST, uri"/v1/ingest").withEntity(ingestReq)
        resp <- app.run(req)
      } yield {
        resp.status shouldBe Status.BadRequest
      }
    }
  }

  // ── Test 10: POST /v1/diff returns 422 without entityId ─────────────

  it should "return 422 for diff without entityId" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)

      for {
        _    <- client.ensureSchema()
        diffReq = Json.obj(
          "fromRev" -> 0L.asJson,
          "toRev"   -> 1L.asJson
        )
        req   = Request[IO](Method.POST, uri"/v1/diff").withEntity(diffReq)
        resp <- app.run(req)
      } yield {
        resp.status shouldBe Status.UnprocessableEntity
      }
    }
  }

  // ── Test 11: POST /v1/provenance/:id returns provenance chain ─────────

  it should "return provenance chain for entity" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val app      = buildRoutes(client, writeApi, queryApi)
      val nodeId   = NodeId(UUID.randomUUID())
      val patch    = makePatch(
        ops = Vector(
          PatchOp.UpsertNode(nodeId, NodeKind.Function, "prov_func", Map.empty[String, Json])
        )
      )

      for {
        _    <- client.ensureSchema()
        _    <- writeApi.commitPatch(patch)
        req   = Request[IO](Method.POST, Uri.unsafeFromString(s"/v1/provenance/${nodeId.value}"))
        resp <- app.run(req)
        body <- resp.as[Json]
      } yield {
        resp.status shouldBe Status.Ok
        body.hcursor.downField("entityId").as[String] shouldBe Right(nodeId.value.toString)
        val chain = body.hcursor.downField("chain").focus.flatMap(_.asArray).getOrElse(Vector.empty)
        chain.size should be >= 1
      }
    }
  }
}
