package ix.memory

import cats.effect.{IO, IOApp, Resource}
import com.comcast.ip4s._
import org.http4s.ember.server.EmberServerBuilder
import org.http4s.server.Router

import ix.memory.api.Routes
import ix.memory.conflict.ArcadeConflictService
import ix.memory.context._
import ix.memory.db._
import ix.memory.ingestion._

object Main extends IOApp.Simple {

  override def run: IO[Unit] = {
    val defaultDataDir = sys.props.get("user.home")
      .map(_ + "/.local/share/ix/data/graph")
      .getOrElse("/tmp/ix-memory-graph")

    val serverResource = for {
      // 1. ArcadeDB client
      client <- ArcadeClient.resource(
        sys.env.getOrElse("IX_DATA_DIR", defaultDataDir)
      )
      _ <- Resource.eval(client.ensureSchema())

      // 2. Core APIs
      writeApi     = new ArcadeGraphWriteApi(client)
      queryApi     = new ArcadeGraphQueryApi(client)
      bulkWriteApi = new ArcadeBulkWriteApi(client)

      // 3. Services
      parserRouter         = new ParserRouter()
      ingestionService     = new IngestionService(parserRouter, writeApi, queryApi)
      bulkIngestionService = new BulkIngestionService(parserRouter, bulkWriteApi, queryApi)
      seeder           = new GraphSeeder(queryApi)
      expander         = new GraphExpander(queryApi)
      claimCollector   = new ClaimCollector(queryApi)
      confidenceScorer = new ConfidenceScorerImpl()
      conflictDetector = new ConflictDetectorImpl()
      contextService   = new ContextService(queryApi, seeder, expander,
                           claimCollector, confidenceScorer, conflictDetector)
      conflictService  = new ArcadeConflictService(client, queryApi, writeApi)

      // 4. HTTP routes
      routes = Routes.arcade(contextService, ingestionService, bulkIngestionService, queryApi, writeApi, conflictService, client)

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
