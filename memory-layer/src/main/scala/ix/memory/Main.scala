package ix.memory

import cats.effect.{IO, IOApp, Resource}
import com.comcast.ip4s._
import org.http4s.ember.server.EmberServerBuilder
import org.http4s.server.Router

import ix.memory.api.Routes
import ix.memory.conflict.ConflictService
import ix.memory.context._
import ix.memory.db._
import ix.memory.ingestion._

object Main extends IOApp.Simple {

  override def run: IO[Unit] = {
    val serverResource = for {
      // 1. ArangoDB client
      client <- ArangoClient.resource(
        host     = sys.env.getOrElse("ARANGO_HOST", "localhost"),
        port     = sys.env.getOrElse("ARANGO_PORT", "8529").toInt,
        database = sys.env.getOrElse("ARANGO_DATABASE", "ix_memory"),
        user     = sys.env.getOrElse("ARANGO_USER", "root"),
        password = sys.env.getOrElse("ARANGO_PASSWORD", "")
      )
      _ <- Resource.eval(client.ensureSchema())

      // 2. Core APIs
      writeApi = new ArangoGraphWriteApi(client)
      queryApi = new ArangoGraphQueryApi(client)

      // 3. Services
      parserRouter     = new ParserRouter()
      ingestionService = new IngestionService(parserRouter, writeApi, queryApi)
      seeder           = new GraphSeeder(queryApi)
      expander         = new GraphExpander(queryApi)
      claimCollector   = new ClaimCollector(queryApi)
      confidenceScorer = new ConfidenceScorerImpl()
      conflictDetector = new ConflictDetectorImpl()
      contextService   = new ContextService(queryApi, seeder, expander,
                           claimCollector, confidenceScorer, conflictDetector)
      conflictService  = new ConflictService(client, queryApi, writeApi)

      // 4. HTTP routes
      routes = Routes.all(contextService, ingestionService, queryApi, writeApi, conflictService, client)

      // 5. Server
      server <- EmberServerBuilder
        .default[IO]
        .withHost(host"0.0.0.0")
        .withPort(
          Port.fromInt(sys.env.getOrElse("PORT", "8090").toInt)
            .getOrElse(port"8090"))
        .withHttpApp(Router("/" -> routes).orNotFound)
        .build
    } yield server

    serverResource.use { server =>
      IO.println(s"Ix Memory Layer running at ${server.address}") *> IO.never
    }
  }
}
