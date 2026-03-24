package ix.memory.db

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
   */
  def truncateCodeGraph(): IO[Unit] = {
    val codeKinds = Array(
      "file", "function", "class", "method", "interface",
      "module", "chunk", "region"
    )
    val codePredicates = Array(
      "CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS",
      "CONTAINS", "DEFINES", "CONTAINS_CHUNK", "REFERENCES", "NEXT", "IN_REGION"
    )
    for {
      _ <- execute(
             "FOR n IN nodes FILTER n.kind IN @kinds REMOVE n IN nodes",
             Map("kinds" -> codeKinds.asInstanceOf[AnyRef])
           )
      _ <- execute(
             "FOR e IN edges FILTER e.predicate IN @predicates REMOVE e IN edges",
             Map("predicates" -> codePredicates.asInstanceOf[AnyRef])
           )
      // Also remove code-ingest patches so getSourceHashes returns empty after reset,
      // preventing the ingest client from treating all files as unchanged.
      _ <- execute(
             "FOR p IN patches FILTER STARTS_WITH(p.data.source.extractor, 'tree-sitter') REMOVE p IN patches",
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
