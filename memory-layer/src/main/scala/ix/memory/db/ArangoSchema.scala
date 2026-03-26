package ix.memory.db

import cats.effect.IO
import com.arangodb.ArangoDatabase
import com.arangodb.entity.CollectionType
import com.arangodb.model.{CollectionCreateOptions, PersistentIndexOptions, TtlIndexOptions}

object ArangoSchema {

  def ensure(db: ArangoDatabase): IO[Unit] = IO.blocking {
    // Vertex collections
    ensureCollection(db, "nodes")
    ensureCollection(db, "claims")
    ensureCollection(db, "conflict_sets")
    ensureCollection(db, "patches")
    ensureCollection(db, "revisions")
    ensureCollection(db, "idempotency_keys")

    // Edge collection
    ensureCollection(db, "edges", edge = true)

    // Indexes — nodes
    val nodes = db.collection("nodes")
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("kind"),
      new PersistentIndexOptions()
    )
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("name"),
      new PersistentIndexOptions().sparse(true)
    )
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("logical_id"),
      new PersistentIndexOptions()
    )
    // Compound index for tombstone query: FILTER logical_id IN @ids AND deleted_rev == null
    // Without this, the single-field logical_id index returns all historical versions of each
    // node and applies deleted_rev as a post-filter — gets slower as the collection grows.
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("logical_id", "deleted_rev"),
      new PersistentIndexOptions()
    )

    // Indexes — edges
    val edges = db.collection("edges")
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("src"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("dst"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("predicate"),
      new PersistentIndexOptions()
    )

    // Indexes — nodes (provenance)
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("provenance.source_uri"),
      new PersistentIndexOptions().sparse(true)
    )

    // Indexes — claims
    val claims = db.collection("claims")
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("entity_id"),
      new PersistentIndexOptions()
    )
    // Compound index for retire query: FILTER entity_id IN @ids AND deleted_rev == null
    // Mirrors the nodes compound index — avoids post-filtering all historical claim versions.
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("entity_id", "deleted_rev"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("status"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("entity_id", "field", "deleted_rev"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("field"),
      new PersistentIndexOptions().sparse(true)
    )

    // Indexes — patches
    val patches = db.collection("patches")
    patches.ensurePersistentIndex(
      java.util.Arrays.asList("patch_id"),
      new PersistentIndexOptions().unique(true)
    )
    patches.ensurePersistentIndex(
      java.util.Arrays.asList("data.source.uri", "data.source.extractor"),
      new PersistentIndexOptions()
    )

    // Indexes — idempotency_keys
    val idem = db.collection("idempotency_keys")
    idem.ensurePersistentIndex(
      java.util.Arrays.asList("key"),
      new PersistentIndexOptions().unique(true)
    )
    idem.ensureTtlIndex(
      java.util.Arrays.asList("created_at"),
      new TtlIndexOptions().expireAfter(86400)
    )

    ()
  }

  private def ensureCollection(db: ArangoDatabase, name: String, edge: Boolean = false): Unit = {
    if (!db.collection(name).exists()) {
      if (edge) {
        db.createCollection(name, new CollectionCreateOptions().`type`(CollectionType.EDGES))
      } else {
        db.createCollection(name)
      }
    }
  }
}
