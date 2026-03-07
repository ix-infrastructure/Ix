package ix.memory.db

import cats.effect.IO
import io.circe.Json
import ix.memory.model._

trait GraphQueryApi {
  def getNode(id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]]
  def findNodesByKind(kind: NodeKind, limit: Int = 100): IO[Vector[GraphNode]]
  def listDecisions(limit: Int = 50, topic: Option[String] = None): IO[Vector[GraphNode]]
  def searchNodes(text: String, limit: Int = 20): IO[Vector[GraphNode]]
  def expand(nodeId: NodeId, direction: Direction,
             predicates: Option[Set[String]] = None, hops: Int = 1,
             asOfRev: Option[Rev] = None): IO[ExpandResult]
  def getClaims(entityId: NodeId): IO[Vector[Claim]]
  def getLatestRev: IO[Rev]
  def getPatchesForEntity(entityId: NodeId): IO[List[Json]]
  def getPatchesBySource(sourceUri: String, extractor: String): IO[Vector[Json]]
  def getChangedEntities(fromRev: Rev, toRev: Rev): IO[Vector[GraphNode]]
}

sealed trait Direction
object Direction {
  case object Out  extends Direction
  case object In   extends Direction
  case object Both extends Direction
}

final case class ExpandResult(nodes: Vector[GraphNode], edges: Vector[GraphEdge])
