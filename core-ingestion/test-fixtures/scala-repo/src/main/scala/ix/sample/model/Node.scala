// Frozen fixture. Synthetic, not a copy of any backend source: this repo is
// public and the Scala backend it used to vendor is not, which is why these
// tests could not simply be repointed at the sibling repo (#557).
//
// Shape matters more than content — the parser features under test are a
// package clause, an import, a sealed trait with case objects extending it,
// a case class with typed fields, and a companion object.
package ix.sample.model

import java.time.Instant

sealed trait NodeKind

object NodeKind {
  case object Module   extends NodeKind
  case object File     extends NodeKind
  case object Class    extends NodeKind
  case object Function extends NodeKind
}

final case class Node(
  id: String,
  kind: NodeKind,
  name: String,
  createdAt: Instant,
)

object Node {
  def module(id: String, name: String, createdAt: Instant): Node =
    Node(id, NodeKind.Module, name, createdAt)
}
