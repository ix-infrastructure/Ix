package ix.memory.db

import cats.effect.IO
import ix.memory.model._

trait GraphWriteApi {
  def commitPatch(patch: GraphPatch): IO[CommitResult]
}

final case class CommitResult(newRev: Rev, status: CommitStatus)

sealed trait CommitStatus
object CommitStatus {
  case object Ok              extends CommitStatus
  case object Idempotent      extends CommitStatus
  case object BaseRevMismatch extends CommitStatus
}
