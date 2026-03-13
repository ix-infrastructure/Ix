package ix.memory.db

import cats.effect.IO
import com.arcadedb.database.Database
import com.arcadedb.schema.{DocumentType, Schema, Type}

object ArcadeSchema {

  def ensure(db: Database): IO[Unit] = IO.blocking {
    db.transaction(() => {
      val schema = db.getSchema

      // Vertex types
      val nodes = schema.getOrCreateVertexType("ix_nodes")
      val claims = schema.getOrCreateVertexType("ix_claims")
      val patches = schema.getOrCreateVertexType("ix_patches")
      schema.getOrCreateVertexType("ix_revisions")
      val idempotencyKeys = schema.getOrCreateVertexType("ix_idempotency_keys")
      schema.getOrCreateVertexType("ix_conflict_sets")
      val meta = schema.getOrCreateVertexType("ix_meta")
      ensureProperty(meta, "schemaVersion", Type.INTEGER)
      ensureProperty(meta, "appVersion", Type.STRING)
      ensureProperty(meta, "migratedAt", Type.STRING)

      // ix_edges stored as vertex type (we query by src/dst fields, not native traversal)
      val edges = schema.getOrCreateVertexType("ix_edges")

      // Properties & Indexes — ix_nodes
      ensureProperty(nodes, "kind", Type.STRING)
      ensureProperty(nodes, "name", Type.STRING)
      ensureProperty(nodes, "logical_id", Type.STRING)
      ensureProperty(nodes, "source_uri", Type.STRING)
      createIndex(schema, unique = false, "ix_nodes", "kind")
      createIndex(schema, unique = false, "ix_nodes", "name")
      createIndex(schema, unique = false, "ix_nodes", "logical_id")
      createIndex(schema, unique = false, "ix_nodes", "source_uri")

      // Properties & Indexes — ix_edges
      ensureProperty(edges, "edge_id", Type.STRING)
      ensureProperty(edges, "src", Type.STRING)
      ensureProperty(edges, "dst", Type.STRING)
      ensureProperty(edges, "predicate", Type.STRING)
      createIndex(schema, unique = false, "ix_edges", "edge_id")
      createIndex(schema, unique = false, "ix_edges", "src")
      createIndex(schema, unique = false, "ix_edges", "dst")
      createIndex(schema, unique = false, "ix_edges", "predicate")

      // Properties & Indexes — ix_claims
      ensureProperty(claims, "entity_id", Type.STRING)
      ensureProperty(claims, "status", Type.STRING)
      ensureProperty(claims, "field", Type.STRING)
      createIndex(schema, unique = false, "ix_claims", "entity_id")
      createIndex(schema, unique = false, "ix_claims", "status")
      createIndex(schema, unique = false, "ix_claims", "field")

      // Properties & Indexes — ix_patches
      ensureProperty(patches, "patch_id", Type.STRING)
      createIndex(schema, unique = true, "ix_patches", "patch_id")

      // Properties & Indexes — ix_idempotency_keys
      ensureProperty(idempotencyKeys, "key", Type.STRING)
      createIndex(schema, unique = true, "ix_idempotency_keys", "key")
    })
  }

  private def ensureProperty(docType: DocumentType, name: String, propType: Type): Unit = {
    if (!docType.existsProperty(name)) {
      docType.createProperty(name, propType)
    }
  }

  private def createIndex(
    schema: Schema,
    unique: Boolean,
    typeName: String,
    propertyNames: String*
  ): Unit = {
    schema.getOrCreateTypeIndex(
      Schema.INDEX_TYPE.LSM_TREE,
      unique,
      typeName,
      propertyNames: _*
    )
  }
}
