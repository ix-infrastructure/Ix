package ix.memory.context

import ix.memory.model._

object RelevanceScorer {
  def score(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge]
  ): Vector[ScoredClaim] =
    scoreWithTerms(claims, seedNodeIds, expandedEdges, Vector.empty, Map.empty)

  def scoreWithTerms(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge],
    queryTerms: Vector[String],
    nodeKindMap: Map[NodeId, NodeKind] = Map.empty
  ): Vector[ScoredClaim] = {
    val oneHopIds = expandedEdges
      .flatMap(e => Vector(e.src, e.dst))
      .toSet -- seedNodeIds
    val termsLower = queryTerms.map(_.toLowerCase)

    claims.map { sc =>
      val hopRelevance =
        if (seedNodeIds.contains(sc.claim.entityId)) 1.0
        else if (oneHopIds.contains(sc.claim.entityId)) 0.7
        else 0.4

      val fieldLower = sc.claim.statement.toLowerCase
      val exactBoost = if (termsLower.exists(t => fieldLower.contains(t))) 1.2 else 1.0

      val pathLower = sc.claim.provenance.sourceUri.toLowerCase
      val pathBoost = if (termsLower.exists(t => pathLower.contains(t))) 1.1 else 1.0

      val kindBoost = nodeKindMap.get(sc.claim.entityId) match {
        case Some(NodeKind.Method) | Some(NodeKind.Function)  => 1.3
        case Some(NodeKind.Class) | Some(NodeKind.Trait)
           | Some(NodeKind.Object) | Some(NodeKind.Interface) => 1.3
        case Some(NodeKind.Module)                            => 1.2
        case Some(NodeKind.File)                              => 0.6
        case _                                                => 1.0
      }

      val relevance = math.min(1.0, hopRelevance * exactBoost * pathBoost * kindBoost)
      sc.copy(relevance = relevance, finalScore = relevance * sc.confidence.score)
    }
  }
}
