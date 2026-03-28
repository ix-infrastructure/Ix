package ix.memory.context

import cats.effect.IO
import cats.syntax.parallel._

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
            asOfRev: Option[Rev] = None,
            depth: Option[String] = None): IO[StructuredContext] =
    for {
      // 0. Resolve revision + depth (used for scoring + output shaping)
      rev <- asOfRev.fold(queryApi.getLatestRev)(IO.pure)
      // Normalize depth values coming from different clients:
      // - MCP server may send shallow|deep
      // - CLI may send compact|standard|full
      effectiveDepthRaw = depth.getOrElse("standard").toLowerCase
      effectiveDepth = effectiveDepthRaw match {
        case "shallow" => "compact"
        case "deep"    => "full"
        case other      => other
      }

      // Strict limits to prevent huge MCP payloads
      (claimLimit, nodeLimit, edgeLimit, conflictLimit) = effectiveDepth match {
        case "compact" => (8, 8, 10, 3)
        case "full"    => (250, 200, 800, 100)
        case _          => (30, 40, 120, 15) // standard
      }

      // 1. Extract entity keywords from the natural language query
      terms <- IO.pure(EntityExtractor.extract(question))

      // 2. Seed: search the graph for nodes matching extracted terms
      seeds <- seeder.seed(terms, asOfRev)

      // 3. Expand: traverse the graph 1 hop from each seed (with edge priority)
      expanded <- expander.expand(seeds.map(_.id), hops = 1, asOfRev = asOfRev)

      // 4. Collect claims for all discovered nodes
      allNodeIds = (seeds.map(_.id) ++ expanded.nodes.map(_.id)).distinct
      claims <- claimCollector.collect(allNodeIds)

      // 4.5. Detect stale sources + count corroboration in parallel
      stalenessAndCorroboration <- (
        StalenessDetector.detect(claims),
        IO.blocking(CorroborationCounter.count(claims))
      ).parTupled
      (stalenessMap, corroborationMap) = stalenessAndCorroboration

      // 5. Score each claim for confidence
      scored = claims.map { c =>
        confidenceScorer.score(c, ScoringContext(
          latestRev          = rev,
          sourceChanged      = stalenessMap.getOrElse(c.id, false),
          corroboratingCount = corroborationMap.getOrElse(c.id, 0),
          conflictState      = ConflictState.NoConflict,
          intentAlignment    = IntentAlignment.NoConnection,
          observedAt         = c.provenance.observedAt
        ))
      }

      // 7. Relevance score: weight claims by hop distance from seeds, boost exact matches, prefer symbols
      nodeKindMap: Map[NodeId, NodeKind] = (seeds ++ expanded.nodes).map(n => n.id -> n.kind).toMap
      relevant = RelevanceScorer.scoreWithTerms(scored, seeds.map(_.id).toSet, expanded.edges, terms, nodeKindMap)

      // 8. Rank claims by finalScore (relevance x confidence) descending
      ranked = ContextRanker.rank(relevant)

      // 8.5 Trim claims to strict limit (prevents massive MCP responses)
      rankedTrimmed = ranked.take(claimLimit)

      // 9. Detect conflicts only within the trimmed claim set
      pass12Conflicts = conflictDetector.detect(rankedTrimmed.toVector)

      // 9.5 Refine conflicts with LLM (Pass 3, if available) using the same trimmed claims
      conflictsAll <- conflictDetector match {
        case impl: ConflictDetectorImpl => impl.refineWithLlm(pass12Conflicts, rankedTrimmed.toVector)
        case _ => IO.pure(pass12Conflicts)
      }

      // Only surface hard conflicts in query responses.
      // Heuristic "Potential inconsistency" reports are too noisy for MCP/LLM output.
      hardConflictsOnly: Vector[ConflictReport] = conflictsAll.filterNot(_.reason.startsWith("Potential inconsistency"))
      conflictsTrimmed: Vector[ConflictReport] = hardConflictsOnly.take(conflictLimit)

      // Collect decisions and intents from expanded nodes (apply strict node/edge limits)
      allNodesAll: Vector[GraphNode] = (seeds ++ expanded.nodes).distinctBy(_.id)
      allNodes: Vector[GraphNode] = allNodesAll.take(nodeLimit)
      edgesTrimmed: Vector[GraphEdge] = expanded.edges.take(edgeLimit)

      // Lightweight summaries for LLM navigation (lets the model drill down with ix_entity/ix_expand)
      nodeSummaries: Vector[NodeSummary] = allNodes.map { n =>
        val display = n.attrs.hcursor.get[String]("name").toOption
          .orElse(n.attrs.hcursor.get[String]("title").toOption)
          .orElse(n.attrs.hcursor.get[String]("heading").toOption)
          .getOrElse {
            val uri = n.provenance.sourceUri
            val basename = uri.split("/").lastOption.getOrElse(uri)
            if (basename.nonEmpty) basename else n.id.value.toString.take(8)
          }
        NodeSummary(n.id, n.kind, display, rev)
      }
      edgeSummaries: Vector[EdgeSummary] = edgesTrimmed.map(e => EdgeSummary(e.id, e.src, e.dst, e.predicate, rev))

      // In compact/standard, omit full nodes/edges to keep MCP payload small.
      nodesOut: Vector[GraphNode] = if (effectiveDepth == "full") allNodes else Vector.empty
      edgesOut: Vector[GraphEdge] = if (effectiveDepth == "full") edgesTrimmed else Vector.empty

      decisions: Vector[DecisionReport] = allNodes.filter(_.kind == NodeKind.Decision).map(toDecisionReport(_, rev))
      intents: Vector[IntentReport] = allNodes.filter(_.kind == NodeKind.Intent).map(toIntentReport)

      // Shape claims and compactClaims based on depth
      claimsOut: List[ScoredClaim] = effectiveDepth match {
        case "compact" => Nil
        case _         => rankedTrimmed.toList
      }
      compactClaimsOut: List[CompactScoredClaim] = effectiveDepth match {
        case "full" => Nil
        case _      => rankedTrimmed.map(_.toCompact).toList
      }

    } yield StructuredContext(
      claims         = claimsOut,
      compactClaims  = compactClaimsOut,
      conflicts      = conflictsTrimmed.toList,
      decisions      = decisions.toList,
      intents        = intents.toList,
      nodes          = nodesOut.toList,
      edges          = edgesOut.toList,
      nodeSummaries  = nodeSummaries.toList,
      edgeSummaries  = edgeSummaries.toList,
      metadata       = ContextMetadata(
        query        = question,
        seedEntities = seeds.map(_.id).take(25).toList,
        hopsExpanded = 1,
        asOfRev      = rev,
        depth        = Some(effectiveDepthRaw)
      )
    )

  private def toDecisionReport(node: GraphNode, rev: Rev): DecisionReport =
    DecisionReport(
      title     = node.attrs.hcursor.get[String]("title").getOrElse(node.id.value.toString),
      rationale = node.attrs.hcursor.get[String]("rationale").getOrElse(""),
      entityId  = Some(node.id),
      intentId  = node.attrs.hcursor.get[String]("intent_id").toOption.flatMap(s =>
        scala.util.Try(java.util.UUID.fromString(s)).toOption.map(NodeId(_))
      ),
      rev       = rev
    )

  private def toIntentReport(node: GraphNode): IntentReport =
    IntentReport(
      id           = node.id,
      statement    = node.attrs.hcursor.get[String]("statement").getOrElse(""),
      status       = node.attrs.hcursor.get[String]("status").getOrElse("active"),
      confidence   = node.attrs.hcursor.get[Double]("confidence").getOrElse(1.0),
      parentIntent = node.attrs.hcursor.get[String]("parent_intent").toOption
    )
}
