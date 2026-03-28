package ix.memory.db

import scala.concurrent.duration._

import cats.effect.{IO, Resource}
import cats.syntax.traverse._
import com.arangodb.{ArangoDB, ArangoDatabase}
import com.arangodb.entity.MultiDocumentEntity
import com.arangodb.model.{AqlQueryOptions, DocumentCreateOptions, OverwriteMode, StreamTransactionOptions}
import com.fasterxml.jackson.databind.ObjectMapper
import io.circe.Json
import io.circe.parser.{parse => parseJson}

import scala.jdk.CollectionConverters._

class ArangoClient private (db: ArangoDatabase) {
  private val mapper = new ObjectMapper()

  private def toJson(value: AnyRef): IO[Json] =
    IO.fromEither(
      parseJson(mapper.writeValueAsString(value))
        .left.map(e => new RuntimeException(s"Failed to parse ArangoDB result: ${e.message}"))
    )

  private def asJava(bindVars: Map[String, AnyRef]): java.util.Map[String, AnyRef] = {
    val m = new java.util.HashMap[String, AnyRef]()
    bindVars.foreach { case (k, v) => m.put(k, v) }
    m
  }

  private def queryOptions(txId: Option[String]): AqlQueryOptions =
    txId.fold(new AqlQueryOptions())(id => new AqlQueryOptions().streamTransactionId(id))

  def query(
    aql: String,
    bindVars: Map[String, AnyRef] = Map.empty,
    txId: Option[String] = None
  ): IO[List[Json]] =
    IO.blocking {
      val cursor = db.query(aql, classOf[AnyRef], asJava(bindVars), queryOptions(txId))
      cursor.asListRemaining().asScala.toList
    }.flatMap(_.traverse(toJson))

  def queryOne(
    aql: String,
    bindVars: Map[String, AnyRef] = Map.empty,
    txId: Option[String] = None
  ): IO[Option[Json]] =
    query(aql, bindVars, txId).map(_.headOption)

  def execute(
    aql: String,
    bindVars: Map[String, AnyRef] = Map.empty,
    txId: Option[String] = None
  ): IO[Unit] =
    IO.blocking {
      db.query(aql, classOf[Void], asJava(bindVars), queryOptions(txId))
      ()
    }

  def queryLong(
    aql: String,
    bindVars: Map[String, AnyRef] = Map.empty,
    txId: Option[String] = None
  ): IO[Long] =
    queryOne(aql, bindVars, txId).map {
      _.flatMap(_.asNumber.flatMap(_.toLong)).getOrElse(0L)
    }

  /** Bulk insert/replace documents into a collection. Uses Document API (not AQL). */
  def bulkInsert(
    collection: String,
    documents: Seq[java.util.Map[String, AnyRef]],
    overwriteMode: String = "replace"
  ): IO[Int] =
    if (documents.isEmpty) IO.pure(0)
    else IO.blocking {
      val opts = new DocumentCreateOptions()
        .overwriteMode(OverwriteMode.valueOf(overwriteMode))
        .waitForSync(false)
        .silent(true)
      val docs = new java.util.ArrayList[java.util.Map[String, AnyRef]](documents.size)
      documents.foreach(docs.add)
      val result = db.collection(collection).insertDocuments(docs, opts)
      documents.size - result.getErrors.size
    }

  /** Bulk insert edge documents. Same as bulkInsert but for edge collections. */
  def bulkInsertEdges(
    collection: String,
    documents: Seq[java.util.Map[String, AnyRef]],
    overwriteMode: String = "replace"
  ): IO[Int] = bulkInsert(collection, documents, overwriteMode)

  // ── Stream Transaction lifecycle ──────────────────────────────────

  def beginTransaction(
    readCollections: Seq[String],
    writeCollections: Seq[String]
  ): IO[String] =
    IO.blocking {
      val opts = new StreamTransactionOptions()
        .readCollections(readCollections: _*)
        .writeCollections(writeCollections: _*)
      db.beginStreamTransaction(opts).getId
    }

  def commitTransaction(txId: String): IO[Unit] =
    IO.blocking {
      db.commitStreamTransaction(txId)
      ()
    }

  def abortTransaction(txId: String): IO[Unit] =
    IO.blocking {
      db.abortStreamTransaction(txId)
      ()
    }

  def ensureSchema(): IO[Unit] = ArangoSchema.ensure(db)

  /** Truncate all graph state. Destructive — dev use only. */
  def truncateGraph(): IO[Unit] =
    IO.blocking {
      db.collection("nodes").truncate()
      db.collection("edges").truncate()
      db.collection("patches").truncate()
      db.collection("claims").truncate()
      db.collection("idempotency_keys").truncate()
      db.collection("revisions").truncate()
      db.collection("conflict_sets").truncate()
      ()
    }

  /**
   * Delete only code-derived nodes and edges, preserving planning artifacts
   * (goals/intents, plans, tasks, decisions, bugs and their linking edges).
   *
   * Uses larger batched REMOVE passes and avoids materializing `RETURN 1`
   * result sets for every deleted document. We first count the matching docs,
   * then execute enough bounded delete passes to cover that cardinality, with
   * a final recount only if needed. Edges are removed before nodes.
   */
  def truncateCodeGraph(): IO[Unit] = {
    val batchSize = 5000
    val codeKinds = Array(
      "file", "function", "class", "method", "interface",
      "module", "chunk", "region"
    )
    val codePredicates = Array(
      "CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "CONTAINS", "DEFINES", "CONTAINS_CHUNK", "REFERENCES", "NEXT", "IN_REGION"
    )

    def removeAll(
      countAql: String,
      removeAql: String,
      bindVars: Map[String, AnyRef]
    ): IO[Unit] = {
      val varsWithBatch = bindVars + ("batchSize" -> Int.box(batchSize))

      def runPasses(remaining: Long): IO[Unit] = {
        val passes = math.ceil(remaining.toDouble / batchSize.toDouble).toInt
        (0 until passes).foldLeft(IO.unit) { (acc, _) =>
          acc *> execute(removeAql, varsWithBatch)
        }
      }

      def loop: IO[Unit] =
        queryLong(countAql, bindVars).flatMap { remaining =>
          if (remaining <= 0) IO.unit
          else runPasses(remaining) *> queryLong(countAql, bindVars).flatMap { tail =>
            if (tail <= 0) IO.unit else loop
          }
        }

      loop
    }

    for {
      // Edges first — avoids locking nodes that are about to be removed
      _ <- removeAll(
             "RETURN LENGTH(FOR e IN edges FILTER e.predicate IN @predicates RETURN 1)",
             "FOR e IN edges FILTER e.predicate IN @predicates LIMIT @batchSize REMOVE e IN edges",
             Map("predicates" -> codePredicates.asInstanceOf[AnyRef])
           )
      // Claims next — code ingests append versioned/retracted claims forever, so
      // reset-code must clear them before removing the corresponding nodes.
      _ <- removeAll(
             """RETURN LENGTH(
               |  FOR c IN claims
               |    FILTER LENGTH(
               |      FOR n IN nodes
               |        FILTER n.logical_id == c.entity_id
               |          AND n.kind IN @kinds
               |        LIMIT 1
               |        RETURN 1
               |    ) > 0
               |    RETURN 1
               |)""".stripMargin,
             """FOR c IN claims
               |  FILTER LENGTH(
               |    FOR n IN nodes
               |      FILTER n.logical_id == c.entity_id
               |        AND n.kind IN @kinds
               |      LIMIT 1
               |      RETURN 1
               |  ) > 0
               |  LIMIT @batchSize
               |  REMOVE c IN claims""".stripMargin,
             Map("kinds" -> codeKinds.asInstanceOf[AnyRef])
           )
      _ <- removeAll(
             "RETURN LENGTH(FOR n IN nodes FILTER n.kind IN @kinds RETURN 1)",
             "FOR n IN nodes FILTER n.kind IN @kinds LIMIT @batchSize REMOVE n IN nodes",
             Map("kinds" -> codeKinds.asInstanceOf[AnyRef])
           )
      _ <- removeAll(
             "RETURN LENGTH(FOR p IN patches FILTER STARTS_WITH(p.data.source.extractor, 'tree-sitter') RETURN 1)",
             "FOR p IN patches FILTER STARTS_WITH(p.data.source.extractor, 'tree-sitter') LIMIT @batchSize REMOVE p IN patches",
             Map.empty
           )
    } yield ()
  }
}

object ArangoClient {
  def resource(
    host: String,
    port: Int,
    database: String,
    user: String,
    password: String
  ): Resource[IO, ArangoClient] =
    Resource.make(
      IO.blocking {
        val arango = new ArangoDB.Builder()
          .host(host, port)
          .user(user)
          .password(if (password.isEmpty) null else password)
          .maxConnections(64)
          .build()
        val existingDbs = arango.getDatabases.asScala.toSet
        if (!existingDbs.contains(database)) {
          arango.createDatabase(database)
        }
        (arango, new ArangoClient(arango.db(database)))
      }
    ) { case (arango, _) =>
      IO.blocking(arango.shutdown())
    }.map(_._2)
}
