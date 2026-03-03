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
      java.util.Arrays.asList("tenant", "kind"),
      new PersistentIndexOptions()
    )
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "name"),
      new PersistentIndexOptions().sparse(true)
    )

    // Indexes — edges
    val edges = db.collection("edges")
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "src"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "dst"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "predicate"),
      new PersistentIndexOptions()
    )

    // Indexes — claims
    val claims = db.collection("claims")
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "entity_id"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "status"),
      new PersistentIndexOptions()
    )

    // Indexes — patches
    val patches = db.collection("patches")
    patches.ensurePersistentIndex(
      java.util.Arrays.asList("tenant", "patch_id"),
      new PersistentIndexOptions().unique(true)
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
