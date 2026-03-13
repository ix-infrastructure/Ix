package ix.memory.db

import cats.effect.IO
import ix.memory.model._

/**
 * Trait for bulk write APIs, allowing both ArangoDB and ArcadeDB
 * implementations to be used interchangeably by BulkIngestionService.
 */
trait BulkWriteApiBase {
  def commitBatch(fileBatches: Vector[FileBatch], baseRev: Long): IO[CommitResult]
  def commitBatchChunked(fileBatches: Vector[FileBatch], baseRev: Long, chunkSize: Int = 100): IO[CommitResult]
}
