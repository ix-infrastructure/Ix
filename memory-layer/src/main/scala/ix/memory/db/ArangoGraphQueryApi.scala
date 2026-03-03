package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
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
          |  FILTER n._key == @id
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

  override def searchNodes(text: String, limit: Int = 20): IO[Vector[GraphNode]] =
    client.query(
      """FOR n IN nodes
        |  FILTER CONTAINS(LOWER(n.name), LOWER(@text))
        |    AND n.deleted_rev == null
        |  LIMIT @limit
        |  RETURN n""".stripMargin,
      Map(
        "text"   -> text.asInstanceOf[AnyRef],
        "limit"  -> Int.box(limit).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap(parseNode).toVector)

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
                             |  FILTER n.id IN @ids
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

  // ── JSON Parsers (snake_case → camelCase) ───────────────────────────

  private def parseNode(json: Json): Option[GraphNode] = {
    val c = json.hcursor
    val result = for {
      id         <- c.get[String]("id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      kindStr    <- c.get[String]("kind").toOption
      kind       <- NodeKind.decoder.decodeJson(Json.fromString(kindStr)).toOption
      attrs      <- c.get[Json]("attrs").toOption
      provenance <- parseProvenance(c.downField("provenance").focus)
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
      createdAt  <- c.get[String]("created_at").toOption
                      .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
      updatedAt  <- c.get[String]("updated_at").toOption
                      .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
    } yield GraphNode(id, kind, attrs, provenance, createdRev, deletedRev, createdAt, updatedAt)
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
    } yield Claim(key, entityId, field, status, provenance, createdRev, deletedRev)
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
