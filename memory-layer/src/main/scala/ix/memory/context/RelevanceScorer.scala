package ix.memory.context

import ix.memory.model._

object RelevanceScorer {
  def score(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge]
  ): Vector[ScoredClaim] =
    scoreWithTerms(claims, seedNodeIds, expandedEdges, Vector.empty)

  def scoreWithTerms(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge],
    queryTerms: Vector[String]
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

      val relevance = math.min(1.0, hopRelevance * exactBoost * pathBoost)
      sc.copy(relevance = relevance, finalScore = relevance * sc.confidence.score)
    }
  }
}
