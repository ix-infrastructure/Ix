package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.all._
import io.circe.Json

import org.slf4j.LoggerFactory

import ix.memory.model._

class ArangoGraphQueryApi(client: ArangoClient) extends GraphQueryApi {

  private val log = LoggerFactory.getLogger(classOf[ArangoGraphQueryApi])

  // ── Public API ──────────────────────────────────────────────────────

  override def getNode(id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]] =
    for {
      rev    <- asOfRev.fold(getLatestRev)(IO.pure)
      result <- client.queryOne(
        """FOR n IN nodes
          |  FILTER n.logical_id == @id
          |    AND n.created_rev <= @rev
          |    AND (n.deleted_rev == null OR @rev < n.deleted_rev)
          |  RETURN n""".stripMargin,
        Map(
          "id"     -> id.value.toString.asInstanceOf[AnyRef],
          "rev"    -> Long.box(rev.value).asInstanceOf[AnyRef]
        )
      )
    } yield result.flatMap(parseNode)

  override def findNodesByKind(kind: NodeKind, limit: Int = 100): IO[Vector[GraphNode]] =
    client.query(
      """FOR n IN nodes
        |  FILTER n.kind == @kind
        |    AND n.deleted_rev == null
        |  LIMIT @limit
        |  RETURN n""".stripMargin,
      Map(
        "kind"   -> nodeKindToString(kind).asInstanceOf[AnyRef],
        "limit"  -> Int.box(limit).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap(parseNode).toVector)

  override def listDecisions(limit: Int = 50, topic: Option[String] = None): IO[Vector[GraphNode]] = {
    val topicFilter = topic match {
      case Some(_) =>
        """AND (
          |  CONTAINS(LOWER(TO_STRING(n.attrs.title)), LOWER(@topic))
          |  OR CONTAINS(LOWER(TO_STRING(n.attrs.rationale)), LOWER(@topic))
          |)""".stripMargin
      case None => ""
    }
    val aql =
      s"""FOR n IN nodes
         |  FILTER n.kind == "decision"
         |    AND n.deleted_rev == null
         |    $topicFilter
         |  SORT n.created_at DESC
         |  LIMIT @limit
         |  RETURN n""".stripMargin
    val binds = scala.collection.mutable.Map[String, AnyRef](
      "limit" -> Int.box(limit).asInstanceOf[AnyRef]
    )
    topic.foreach(t => binds += ("topic" -> t.asInstanceOf[AnyRef]))
    client.query(aql, binds.toMap).map(_.flatMap(parseNode).toVector)
  }

  override def searchNodes(
    text: String,
    limit: Int = 20,
    kind: Option[String] = None,
    language: Option[String] = None,
    asOfRev: Option[Rev] = None
  ): IO[Vector[GraphNode]] = {
    val liveFilter = asOfRev match {
      case Some(r) => s"AND n.created_rev <= ${r.value} AND (n.deleted_rev == null OR ${r.value} < n.deleted_rev)"
      case None    => "AND n.deleted_rev == null"
    }
    val claimLiveFilter = asOfRev match {
      case Some(r) => s"AND c.created_rev <= ${r.value} AND (c.deleted_rev == null OR ${r.value} < c.deleted_rev)"
      case None    => "AND c.deleted_rev == null"
    }
    val kindFilter = kind.map(_ => "FILTER n2.kind == @kind").getOrElse("")
    val langFilter = language.map(_ => "FILTER CONTAINS(LOWER(TO_STRING(n2.provenance.source_uri)), LOWER(@language))").getOrElse("")

    val aql =
      s"""LET name_matches = (
         |  FOR n IN nodes
         |    FILTER CONTAINS(LOWER(n.name), LOWER(@text))
         |      $liveFilter
         |    RETURN DISTINCT n.logical_id
         |)
         |
         |LET provenance_matches = (
         |  FOR n IN nodes
         |    FILTER CONTAINS(LOWER(n.provenance.source_uri), LOWER(@text))
         |      $liveFilter
         |    RETURN DISTINCT n.logical_id
         |)
         |
         |LET claim_matches = (
         |  FOR c IN claims
         |    FILTER (
         |        CONTAINS(LOWER(c.field), LOWER(@text))
         |        OR CONTAINS(LOWER(TO_STRING(c.value)), LOWER(@text))
         |      )
         |      $claimLiveFilter
         |    RETURN DISTINCT c.entity_id
         |)
         |
         |LET decision_matches = (
         |  FOR n IN nodes
         |    FILTER n.kind == "decision"
         |      $liveFilter
         |      AND (
         |        CONTAINS(LOWER(TO_STRING(n.attrs.title)), LOWER(@text))
         |        OR CONTAINS(LOWER(TO_STRING(n.attrs.rationale)), LOWER(@text))
         |      )
         |    RETURN DISTINCT n.logical_id
         |)
         |
         |LET attr_matches = (
         |  FOR n IN nodes
         |    FILTER CONTAINS(LOWER(TO_STRING(n.attrs)), LOWER(@text))
         |      $liveFilter
         |    RETURN DISTINCT n.logical_id
         |)
         |
         |LET all_ids = UNION_DISTINCT(name_matches, provenance_matches, claim_matches, decision_matches, attr_matches)
         |
         |FOR id IN all_ids
         |  FOR n2 IN nodes
         |    FILTER n2.logical_id == id AND n2.deleted_rev == null
         |    $kindFilter
         |    $langFilter
         |  LET symbol_priority = n2.kind IN ["function", "method", "class", "trait", "object", "interface"] ? 0 : 1
         |  SORT symbol_priority ASC, n2.name ASC
         |  LIMIT @limit
         |  RETURN n2""".stripMargin

    val binds = scala.collection.mutable.Map[String, AnyRef](
      "text"  -> text.asInstanceOf[AnyRef],
      "limit" -> Int.box(limit).asInstanceOf[AnyRef]
    )
    kind.foreach(k => binds += ("kind" -> k.asInstanceOf[AnyRef]))
    language.foreach(l => binds += ("language" -> l.asInstanceOf[AnyRef]))

    client.query(aql, binds.toMap).map(_.flatMap(parseNode).toVector)
  }

  override def expand(
    nodeId: NodeId,
    direction: Direction,
    predicates: Option[Set[String]] = None,
    hops: Int = 1,
    asOfRev: Option[Rev] = None
  ): IO[ExpandResult] = {
    val predicateFilter = predicates.filter(_.nonEmpty) match {
      case Some(_) => " AND e.predicate IN @predicates"
      case None    => ""
    }

    // I4: always use MVCC filter with resolved rev (never bare deleted_rev == null)
    val deletedFilter = " AND e.created_rev <= @rev AND (e.deleted_rev == null OR @rev < e.deleted_rev)"

    def buildEdgeQuery(srcOrDst: String): String =
      s"""FOR e IN edges
         |  FILTER e.$srcOrDst == @nodeId
         |    $deletedFilter
         |    $predicateFilter
         |  RETURN e""".stripMargin

    def buildBindVars(rev: Rev): Map[String, AnyRef] = {
      val base = Map(
        "nodeId" -> nodeId.value.toString.asInstanceOf[AnyRef],
        "rev"    -> Long.box(rev.value).asInstanceOf[AnyRef]
      )
      predicates.filter(_.nonEmpty) match {
        case Some(ps) =>
          val javaList = new java.util.ArrayList[String]()
          ps.foreach(javaList.add)
          base + ("predicates" -> javaList.asInstanceOf[AnyRef])
        case None => base
      }
    }

    for {
      // I4: resolve revision once at the start so edges and nodes see the same snapshot
      resolvedRev <- asOfRev.fold(getLatestRev)(IO.pure)
      bindVars = buildBindVars(resolvedRev)

      outEdges <- direction match {
        case Direction.Out | Direction.Both =>
          client.query(buildEdgeQuery("src"), bindVars).map(_.flatMap(parseEdge).toVector)
        case Direction.In =>
          IO.pure(Vector.empty[GraphEdge])
      }

      inEdges <- direction match {
        case Direction.In | Direction.Both =>
          client.query(buildEdgeQuery("dst"), bindVars).map(_.flatMap(parseEdge).toVector)
        case Direction.Out =>
          IO.pure(Vector.empty[GraphEdge])
      }

      allEdges = (outEdges ++ inEdges).distinctBy(_.id)

      // Collect the "other side" node IDs
      neighborIds = allEdges.flatMap { e =>
        if (e.src == nodeId) Vector(e.dst)
        else if (e.dst == nodeId) Vector(e.src)
        else Vector(e.src, e.dst)
      }.distinct

      // I1: batch-fetch all neighbor nodes in a single AQL query instead of N+1
      nodes <- if (neighborIds.isEmpty) IO.pure(Vector.empty[GraphNode])
               else {
                 val idList = new java.util.ArrayList[String]()
                 neighborIds.foreach(nid => idList.add(nid.value.toString))
                 val aql = """FOR n IN nodes
                             |  FILTER n.logical_id IN @ids
                             |  AND n.created_rev <= @rev AND (n.deleted_rev == null OR @rev < n.deleted_rev)
                             |  RETURN n""".stripMargin
                 client.query(aql, Map(
                   "ids"    -> idList.asInstanceOf[AnyRef],
                   "rev"    -> Long.box(resolvedRev.value).asInstanceOf[AnyRef]
                 )).map(_.flatMap(parseNode).toVector)
               }

    } yield ExpandResult(nodes, allEdges)
  }

  override def getClaims(entityId: NodeId): IO[Vector[Claim]] =
    client.query(
      """FOR c IN claims
        |  FILTER c.entity_id == @entityId
        |    AND c.deleted_rev == null
        |  RETURN c""".stripMargin,
      Map(
        "entityId" -> entityId.value.toString.asInstanceOf[AnyRef]
      )
    ).map(_.flatMap(parseClaim).toVector)

  override def getLatestRev: IO[Rev] =
    client.queryOne(
      """FOR r IN revisions
        |  FILTER r._key == @key
        |  RETURN r.rev""".stripMargin,
      Map("key" -> "current".asInstanceOf[AnyRef])
    ).map(_.flatMap(_.as[Long].toOption).map(Rev(_)).getOrElse(Rev(0L)))

  override def getPatchesForEntity(entityId: NodeId): IO[List[Json]] = {
    val nodeIdStr = entityId.value.toString
    client.query(
      """FOR p IN patches
        |  FILTER LENGTH(
        |    FOR op IN (IS_ARRAY(p.data.ops) ? p.data.ops : [])
        |      FILTER op.id == @nodeId OR op.entityId == @nodeId
        |      RETURN 1
        |  ) > 0
        |  SORT p.rev ASC
        |  RETURN p""".stripMargin,
      Map(
        "nodeId" -> nodeIdStr.asInstanceOf[AnyRef]
      )
    )
  }

  override def getPatchesBySource(sourceUri: String, extractor: String): IO[Vector[Json]] =
    client.query(
      """FOR p IN patches
        |  FILTER p.data.source.uri == @uri AND p.data.source.extractor == @extractor
        |  SORT p.rev DESC
        |  RETURN p""".stripMargin,
      Map(
        "uri"       -> sourceUri.asInstanceOf[AnyRef],
        "extractor" -> extractor.asInstanceOf[AnyRef]
      )
    ).map(_.toVector)

  override def getChangedEntities(fromRev: Rev, toRev: Rev): IO[Vector[(GraphNode, Option[GraphNode])]] = {
    val changedIdsAql = """
      FOR n IN nodes
        FILTER n.created_rev > @fromRev AND n.created_rev <= @toRev
        COLLECT logicalId = n.logical_id
        RETURN logicalId
    """
    for {
      logicalIds <- client.query(changedIdsAql, Map(
        "fromRev" -> Long.box(fromRev.value).asInstanceOf[AnyRef],
        "toRev"   -> Long.box(toRev.value).asInstanceOf[AnyRef]
      )).map(_.flatMap(_.asString).toVector)
      results <- logicalIds.traverse { lid =>
        val nodeId = NodeId(java.util.UUID.fromString(lid))
        for {
          atFrom <- getNode(nodeId, asOfRev = Some(fromRev))
          atTo   <- getNode(nodeId, asOfRev = Some(toRev))
        } yield atTo.map(to => (to, atFrom))
      }
    } yield results.flatten
  }

  override def resolvePrefix(prefix: String): IO[Vector[NodeId]] =
    client.query(
      """FOR n IN nodes
        |  FILTER n.deleted_rev == null
        |    AND STARTS_WITH(n.logical_id, @prefix)
        |  COLLECT lid = n.logical_id
        |  LIMIT 10
        |  RETURN lid""".stripMargin,
      Map("prefix" -> prefix.asInstanceOf[AnyRef])
    ).map(_.flatMap(_.asString).flatMap(s =>
      scala.util.Try(java.util.UUID.fromString(s)).toOption.map(NodeId(_))
    ).toVector)

  override def getSourceHashes(sourceUris: Seq[String]): IO[Map[String, String]] = {
    if (sourceUris.isEmpty) IO.pure(Map.empty)
    else {
      val uriList = new java.util.ArrayList[String](sourceUris.size)
      sourceUris.foreach(uriList.add)
      client.query(
        """FOR p IN patches
          |  FILTER p.data.source.uri IN @uris
          |  SORT p.rev DESC
          |  COLLECT uri = p.data.source.uri INTO groups
          |  LET latest = FIRST(groups)
          |  RETURN { uri: uri, hash: latest.p.data.source.sourceHash }""".stripMargin,
        Map("uris" -> uriList.asInstanceOf[AnyRef])
      ).map { results =>
        results.flatMap { json =>
          for {
            uri  <- json.hcursor.get[String]("uri").toOption
            hash <- json.hcursor.get[String]("hash").toOption
          } yield uri -> hash
        }.toMap
      }
    }
  }

  override def expandByName(
    name: String,
    direction: Direction,
    predicates: Option[Set[String]] = None,
    kinds: Option[Set[NodeKind]] = None
  ): IO[ExpandResult] = {
    val kindFilter = kinds.filter(_.nonEmpty) match {
      case Some(_) => " AND n.kind IN @kinds"
      case None    => ""
    }
    val predicateFilter = predicates.filter(_.nonEmpty) match {
      case Some(_) => " AND e.predicate IN @predicates"
      case None    => ""
    }
    val directionFilter = direction match {
      case Direction.Out  => "FILTER e.src IN target_ids"
      case Direction.In   => "FILTER e.dst IN target_ids"
      case Direction.Both => "FILTER e.src IN target_ids OR e.dst IN target_ids"
    }

    val aql =
      s"""LET target_ids = (
         |  FOR n IN nodes
         |    FILTER n.name == @name AND n.deleted_rev == null
         |      $kindFilter
         |    RETURN DISTINCT n.logical_id
         |)
         |FOR e IN edges
         |  FILTER e.deleted_rev == null
         |  $directionFilter
         |  $predicateFilter
         |  LET other_id = (e.src IN target_ids ? e.dst : e.src)
         |  LET other = FIRST(
         |    FOR n IN nodes
         |      FILTER n.logical_id == other_id AND n.deleted_rev == null
         |      SORT n.created_rev DESC
         |      LIMIT 1
         |      RETURN n
         |  )
         |  FILTER other != null
         |  RETURN { edge: e, node: other }""".stripMargin

    val binds = scala.collection.mutable.Map[String, AnyRef](
      "name" -> name.asInstanceOf[AnyRef]
    )
    kinds.filter(_.nonEmpty).foreach { ks =>
      val kindList = new java.util.ArrayList[String]()
      ks.foreach(k => kindList.add(nodeKindToString(k)))
      binds += ("kinds" -> kindList.asInstanceOf[AnyRef])
    }
    predicates.filter(_.nonEmpty).foreach { ps =>
      val predList = new java.util.ArrayList[String]()
      ps.foreach(predList.add)
      binds += ("predicates" -> predList.asInstanceOf[AnyRef])
    }

    client.query(aql, binds.toMap).map { results =>
      val edges = results.flatMap { json =>
        json.hcursor.downField("edge").focus.flatMap(parseEdge)
      }.toVector
      val nodes = results.flatMap { json =>
        json.hcursor.downField("node").focus.flatMap(parseNode)
      }.toVector
      ExpandResult(nodes, edges)
    }
  }

  // ── JSON Parsers (snake_case → camelCase) ───────────────────────────

  private def parseNode(json: Json): Option[GraphNode] = {
    val c = json.hcursor
    val result = for {
      id         <- c.get[String]("id").toOption
                      .orElse(c.get[String]("logical_id").toOption)
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      kindStr    <- c.get[String]("kind").toOption
      kind       <- NodeKind.decoder.decodeJson(Json.fromString(kindStr)).toOption
      name        = c.get[String]("name").getOrElse("")
      attrs      <- c.get[Json]("attrs").toOption
      provenance <- parseProvenance(c.downField("provenance").focus)
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
      createdAt  <- c.get[String]("created_at").toOption
                      .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
      updatedAt  <- c.get[String]("updated_at").toOption
                      .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
    } yield GraphNode(id, kind, name, attrs, provenance, createdRev, deletedRev, createdAt, updatedAt)
    if (result.isEmpty) log.warn("Failed to parse node from JSON: {}", json.noSpaces.take(200))
    result
  }

  private def parseEdge(json: Json): Option[GraphEdge] = {
    val c = json.hcursor
    val result = for {
      id         <- c.get[String]("id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(EdgeId(_))
      src        <- c.get[String]("src").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      dst        <- c.get[String]("dst").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      predicate  <- c.get[String]("predicate").toOption.map(EdgePredicate(_))
      attrs      <- c.get[Json]("attrs").toOption
      provenance <- parseProvenance(c.downField("provenance").focus)
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
    } yield GraphEdge(id, src, dst, predicate, attrs, provenance, createdRev, deletedRev)
    if (result.isEmpty) log.warn("Failed to parse edge from JSON: {}", json.noSpaces.take(200))
    result
  }

  private def parseClaim(json: Json): Option[Claim] = {
    val c = json.hcursor
    val result = for {
      key        <- c.get[String]("_key").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(ClaimId(_))
      entityId   <- c.get[String]("entity_id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      field      <- c.get[String]("field").toOption
      value      = c.downField("value").focus.getOrElse(Json.Null)
      confidence  = c.get[Double]("confidence").toOption
      statusStr  <- c.get[String]("status").toOption
      status     <- statusStr.toLowerCase match {
                      case "active"    => Some(ClaimStatus.Active)
                      case "stale"     => Some(ClaimStatus.Stale)
                      case "retracted" => Some(ClaimStatus.Retracted)
                      case _           => None
                    }
      provenance <- parseProvenance(c.downField("provenance").focus)
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
    } yield Claim(key, entityId, field, value, confidence, status, provenance, createdRev, deletedRev)
    if (result.isEmpty) log.warn("Failed to parse claim from JSON: {}", json.noSpaces.take(200))
    result
  }

  private def parseProvenance(jsonOpt: Option[Json]): Option[Provenance] = {
    jsonOpt.flatMap { json =>
      val c = json.hcursor
      for {
        sourceUri  <- c.get[String]("source_uri").toOption
        sourceHash  = c.get[String]("source_hash").toOption
        extractor  <- c.get[String]("extractor").toOption
        stStr      <- c.get[String]("source_type").toOption
        sourceType <- SourceType.decoder.decodeJson(Json.fromString(stStr)).toOption
        observedAt <- c.get[String]("observed_at").toOption
                        .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
      } yield Provenance(sourceUri, sourceHash, extractor, sourceType, observedAt)
    }
  }

  private def nodeKindToString(nk: NodeKind): String =
    NodeKind.encoder.apply(nk).asString.getOrElse(nk.toString)
}
