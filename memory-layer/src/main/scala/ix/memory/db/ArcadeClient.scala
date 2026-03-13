package ix.memory.db

import cats.effect.{IO, Resource}
import com.arcadedb.database.{Database, DatabaseFactory}
import io.circe.Json
import io.circe.parser.{parse => parseJson}

import scala.jdk.CollectionConverters._

class ArcadeClient private (db: Database) {

  private def resultSetToList(rs: com.arcadedb.query.sql.executor.ResultSet): List[Json] = {
    val buf = List.newBuilder[Json]
    while (rs.hasNext) {
      val row = rs.next()
      val jsonStr = row.toJSON.toString
      parseJson(jsonStr) match {
        case Right(j) => buf += j
        case Left(e)  => throw new RuntimeException(s"Failed to parse ArcadeDB result: ${e.message}")
      }
    }
    rs.close()
    buf.result()
  }

  private def asJava(params: Map[String, AnyRef]): java.util.Map[String, AnyRef] = {
    val m = new java.util.HashMap[String, AnyRef]()
    params.foreach { case (k, v) => m.put(k, v) }
    m
  }

  def query(sql: String, params: Map[String, AnyRef] = Map.empty): IO[List[Json]] =
    IO.blocking {
      val rs = db.query("sql", sql, asJava(params))
      resultSetToList(rs)
    }

  def queryOne(sql: String, params: Map[String, AnyRef] = Map.empty): IO[Option[Json]] =
    query(sql, params).map(_.headOption)

  def command(sql: String, params: Map[String, AnyRef] = Map.empty): IO[Unit] =
    IO.blocking {
      db.transaction(() => {
        val rs = db.command("sql", sql, asJava(params))
        rs.close()
      })
    }

  def commandWithResults(sql: String, params: Map[String, AnyRef] = Map.empty): IO[List[Json]] =
    IO.blocking {
      var results: List[Json] = Nil
      db.transaction(() => {
        val rs = db.command("sql", sql, asJava(params))
        results = resultSetToList(rs)
      })
      results
    }

  def transact[A](body: Database => IO[A]): IO[A] =
    IO.blocking(db.begin()) *>
      body(db).attempt.flatMap {
        case Right(a) => IO.blocking(db.commit()) *> IO.pure(a)
        case Left(e)  => IO.blocking(db.rollback()) *> IO.raiseError(e)
      }

  def raw: Database = db

  def ensureSchema(): IO[Unit] = ArcadeSchema.ensure(db)
}

object ArcadeClient {
  def resource(dbPath: String): Resource[IO, ArcadeClient] =
    Resource.make(
      IO.blocking {
        val factory = new DatabaseFactory(dbPath)
        val database = if (factory.exists()) factory.open() else factory.create()
        new ArcadeClient(database)
      }
    )(client => IO.blocking(client.raw.close()))
}
