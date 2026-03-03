package ix.memory.context

import cats.effect.IO

import ix.memory.db.GraphQueryApi
import ix.memory.model._

class ContextService(
  queryApi:         GraphQueryApi,
  seeder:           GraphSeeder,
  expander:         GraphExpander,
  claimCollector:   ClaimCollector,
  confidenceScorer: ConfidenceScorer,
  conflictDetector: ConflictDetector
) {

  def query(question: String,
            asOfRev: Option[Rev] = None): IO[StructuredContext] =
    for {
      // 1. Extract entity keywords from the natural language query
      terms <- IO.pure(EntityExtractor.extract(question))

      // 2. Seed: search the graph for nodes matching extracted terms
      seeds <- seeder.seed(terms, asOfRev)

      // 3. Expand: traverse the graph 1 hop from each seed
      expanded <- expander.expand(seeds.map(_.id), hops = 1, asOfRev = asOfRev)

      // 4. Collect claims for all discovered nodes
      allNodeIds = (seeds.map(_.id) ++ expanded.nodes.map(_.id)).distinct
      claims <- claimCollector.collect(allNodeIds)

      // 5. Score each claim
      rev <- asOfRev.fold(queryApi.getLatestRev)(IO.pure)
      scored = claims.map { c =>
        confidenceScorer.score(c, ScoringContext(
          latestRev          = rev,
          sourceChanged      = false,                     // Default for Phase 1
          corroboratingCount = 1,                         // Default for Phase 1
          conflictState      = ConflictState.NoConflict,  // Default for Phase 1
          intentAlignment    = IntentAlignment.NoConnection,
          observedAt         = c.provenance.observedAt
        ))
      }

      // 6. Detect conflicts among scored claims
      conflicts = conflictDetector.detect(scored)

      // 7. Rank claims by confidence (descending)
      ranked = ContextRanker.rank(scored)

    // 8. Assemble and return StructuredContext
    } yield StructuredContext(
      claims    = ranked.toList,
      conflicts = conflicts.toList,
      decisions = List.empty,
      intents   = List.empty,
      nodes     = (seeds ++ expanded.nodes).distinctBy(_.id).toList,
      edges     = expanded.edges.toList,
      metadata  = ContextMetadata(
        query        = question,
        seedEntities = seeds.map(_.id).toList,
        hopsExpanded = 1,
        asOfRev      = rev,
        depth        = None
      )
    )
}
