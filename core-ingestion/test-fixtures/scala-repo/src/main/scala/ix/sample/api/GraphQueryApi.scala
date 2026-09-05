// Frozen fixture — see Node.scala. The cross-file half of the resolveEdges
// integration test: this file must REFERENCE NodeKind from another package so
// resolution has to reach Node.scala to satisfy it.
package ix.sample.api

import ix.sample.model.{Node, NodeKind}

class GraphQueryApi {
  def kindOf(node: Node): NodeKind = node.kind

  def isFile(node: Node): Boolean = node.kind match {
    case NodeKind.File => true
    case _             => false
  }

  def defaultKind: NodeKind = NodeKind.Module
}
