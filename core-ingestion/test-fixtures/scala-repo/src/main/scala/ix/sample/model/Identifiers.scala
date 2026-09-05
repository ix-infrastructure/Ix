// Frozen fixture — see Node.scala. Exercises value classes and a companion
// object of plain helper defs.
package ix.sample.model

final case class WorkspaceId(value: String) extends AnyVal

final case class NodeId(value: String) extends AnyVal

object Identifiers {
  def nodeId(raw: String): NodeId = NodeId(raw.trim)

  def workspaceId(raw: String): WorkspaceId = WorkspaceId(raw.trim)

  def isBlank(raw: String): Boolean = raw.trim.isEmpty
}
