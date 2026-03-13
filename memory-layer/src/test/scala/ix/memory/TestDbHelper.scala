package ix.memory

import java.nio.file.Files

import cats.effect.IO
import ix.memory.db.ArcadeClient

trait TestDbHelper {

  protected def tempDbResource = {
    val tmpDir = Files.createTempDirectory("arcadedb-test-").toFile.getAbsolutePath
    ArcadeClient.resource(tmpDir)
  }

  /** Delete all records from all ix_ tables to ensure a clean state for each test. */
  protected def cleanDatabase(client: ArcadeClient): IO[Unit] = {
    val tables = List(
      "ix_nodes", "ix_edges", "ix_claims", "ix_patches",
      "ix_revisions", "ix_idempotency_keys", "ix_conflict_sets"
    )
    tables.foldLeft(IO.unit) { (acc, name) =>
      acc >> client.command(s"DELETE FROM $name").attempt.void
    }
  }
}
