package ix.memory.db.migrations

import com.arcadedb.database.Database

object V001_InitialSchema extends Migration {
  val version = 1
  val description = "Initial schema — ix_nodes, ix_edges, ix_claims, ix_patches, ix_revisions"

  def migrate(db: Database): Unit = {
    // Schema types are created by ArcadeSchema.ensureSchema()
    // This migration exists to establish schema version 1 as the baseline
  }
}
