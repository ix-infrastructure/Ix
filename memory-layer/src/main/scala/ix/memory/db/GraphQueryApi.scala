package ix.memory.db

import cats.effect.IO
import ix.memory.model._

trait GraphQueryApi {
  def getNode(tenant: TenantId, id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]]
  def findNodesByKind(tenant: TenantId, kind: NodeKind, limit: Int = 100): IO[Vector[GraphNode]]
  def searchNodes(tenant: TenantId, text: String, limit: Int = 20): IO[Vector[GraphNode]]
  def expand(tenant: TenantId, nodeId: NodeId, direction: Direction,
             predicates: Option[Set[String]] = None, hops: Int = 1,
             asOfRev: Option[Rev] = None): IO[ExpandResult]
  def getClaims(tenant: TenantId, entityId: NodeId): IO[Vector[Claim]]
  def getLatestRev(tenant: TenantId): IO[Rev]
}

sealed trait Direction
object Direction {
  case object Out  extends Direction
  case object In   extends Direction
  case object Both extends Direction
}

final case class ExpandResult(nodes: Vector[GraphNode], edges: Vector[GraphEdge])
