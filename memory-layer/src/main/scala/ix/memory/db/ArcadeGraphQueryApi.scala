package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.all._
import io.circe.Json
import io.circe.parser.{parse => parseJson}

import org.slf4j.LoggerFactory

import ix.memory.model._

class ArcadeGraphQueryApi(client: ArcadeClient) extends GraphQueryApi {

  private val log = LoggerFactory.getLogger(classOf[ArcadeGraphQueryApi])

  // ── Public API ──────────────────────────────────────────────────────

  override def getNode(id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]] =
    for {
      rev    <- asOfRev.fold(getLatestRev)(IO.pure)
      result <- client.queryOne(
        "SELECT FROM ix_nodes WHERE logical_id = :id AND created_rev <= :rev AND (deleted_rev IS NULL OR :rev < deleted_rev)",
        Map(
          "id"  -> id.value.toString.asInstanceOf[AnyRef],
          "rev" -> Long.box(rev.value).asInstanceOf[AnyRef]
        )
      )
    } yield result.flatMap(parseNode)

  override def findNodesByKind(kind: NodeKind, limit: Int = 100): IO[Vector[GraphNode]] =
    client.query(
      "SELECT FROM ix_nodes WHERE kind = :kind AND deleted_rev IS NULL LIMIT :limit",
      Map(
        "kind"  -> nodeKindToString(kind).asInstanceOf[AnyRef],
        "limit" -> Int.box(limit).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap(parseNode).toVector)

  override def listDecisions(limit: Int = 50, topic: Option[String] = None): IO[Vector[GraphNode]] = {
    client.query(
      "SELECT FROM ix_nodes WHERE kind = 'decision' AND deleted_rev IS NULL ORDER BY created_at DESC",
      Map.empty
    ).map { results =>
      val parsed = results.flatMap(parseNode).toVector
      val filtered = topic match {
        case Some(t) =>
          val lower = t.toLowerCase
          parsed.filter { n =>
            val attrsStr = n.attrs.noSpaces.toLowerCase
            attrsStr.contains(lower) || n.name.toLowerCase.contains(lower)
          }
        case None => parsed
      }
      filtered.take(limit)
    }
  }

  override def searchNodes(
    text: String,
    limit: Int = 20,
    kind: Option[String] = None,
    language: Option[String] = None,
    asOfRev: Option[Rev] = None,
    nameOnly: Boolean = false
  ): IO[Vector[GraphNode]] = {

    val lowerText = text.toLowerCase

    // Build MVCC filter for nodes
    val revFilter = asOfRev match {
      case Some(r) =>
        val v = r.value
        s" AND created_rev <= $v AND (deleted_rev IS NULL OR $v < deleted_rev)"
      case None =>
        " AND deleted_rev IS NULL"
    }
    val claimRevFilter = asOfRev match {
      case Some(r) =>
        val v = r.value
        s" AND created_rev <= $v AND (deleted_rev IS NULL OR $v < deleted_rev)"
      case None =>
        " AND deleted_rev IS NULL"
    }

    // Step 1: name matches -- fetch all live nodes and filter in Scala
    val nameMatchesIO: IO[List[(String, Int)]] = client.query(
      s"SELECT logical_id, name FROM ix_nodes WHERE 1 = 1$revFilter",
      Map.empty
    ).map(_.flatMap { json =>
      val c = json.hcursor
      for {
        lid  <- c.get[String]("logical_id").toOption
        name <- c.get[String]("name").toOption
        if name.toLowerCase.contains(lowerText)
      } yield {
        val weight = if (name.toLowerCase == lowerText) 100 else 60
        (lid, weight)
      }
    })

    if (nameOnly) {
      for {
        nameMatches <- nameMatchesIO
        bestPerIdMap = deduplicateByMaxWeight(nameMatches)
        sorted       = bestPerIdMap.toVector.sortBy { case (_, w) => -w }
        limited      = sorted.take(limit)
        nodes       <- fetchAndFilterNodes(limited.map(_._1), kind, language, limited.toMap)
      } yield nodes.sortBy { n =>
        val w = limited.toMap.getOrElse(n.id.value.toString, 0)
        val symbolPriority = if (isSymbolKind(n.kind)) 0 else 1
        (-w, symbolPriority, n.name)
      }.take(limit)
    } else {
      for {
        nameMatches <- nameMatchesIO

        // Step 2: provenance matches (source_uri) -- filter in Scala
        provMatches <- client.query(
          s"SELECT logical_id, source_uri FROM ix_nodes WHERE 1 = 1$revFilter",
          Map.empty
        ).map(_.flatMap { json =>
          val c = json.hcursor
          for {
            lid <- c.get[String]("logical_id").toOption
            uri <- c.get[String]("source_uri").toOption
            if uri.toLowerCase.contains(lowerText)
          } yield (lid, 40)
        })

        // Step 3: claim matches -- filter in Scala
        claimMatches <- client.query(
          s"SELECT entity_id, field, value FROM ix_claims WHERE 1 = 1$claimRevFilter",
          Map.empty
        ).map(_.flatMap { json =>
          val c = json.hcursor
          for {
            eid <- c.get[String]("entity_id").toOption
            field = c.get[String]("field").toOption.getOrElse("")
            value = c.downField("value").focus.map(_.noSpaces).getOrElse("")
            if field.toLowerCase.contains(lowerText) || value.toLowerCase.contains(lowerText)
          } yield (eid, 20)
        })

        // Step 4: decision matches
        decisionMatches <- client.query(
          s"SELECT logical_id, attrs FROM ix_nodes WHERE kind = 'decision'$revFilter",
          Map.empty
        ).map(_.flatMap { json =>
          val c = json.hcursor
          for {
            lid <- c.get[String]("logical_id").toOption
            attrs = c.downField("attrs").focus.map(_.noSpaces).getOrElse("")
            if attrs.toLowerCase.contains(lowerText)
          } yield (lid, 20)
        })

        // Step 5: attr matches (only for terms >= 6 chars)
        attrMatches <- if (text.length >= 6) {
          client.query(
            s"SELECT logical_id, attrs FROM ix_nodes WHERE 1 = 1$revFilter",
            Map.empty
          ).map(_.flatMap { json =>
            val c = json.hcursor
            for {
              lid <- c.get[String]("logical_id").toOption
              attrs = c.downField("attrs").focus.map(_.noSpaces).getOrElse("")
              if attrs.toLowerCase.contains(lowerText)
            } yield (lid, 10)
          })
        } else IO.pure(List.empty[(String, Int)])

        allScored = nameMatches ++ provMatches ++ claimMatches ++ decisionMatches ++ attrMatches
        bestPerIdMap = deduplicateByMaxWeight(allScored)
        sorted  = bestPerIdMap.toVector.sortBy { case (_, w) => -w }
        limited = sorted.take(limit)
        nodes  <- fetchAndFilterNodes(limited.map(_._1), kind, language, limited.toMap)
      } yield nodes.sortBy { n =>
        val w = limited.toMap.getOrElse(n.id.value.toString, 0)
        val symbolPriority = if (isSymbolKind(n.kind)) 0 else 1
        (-w, symbolPriority, n.name)
      }.take(limit)
    }
  }

  override def expand(
    nodeId: NodeId,
    direction: Direction,
    predicates: Option[Set[String]] = None,
    hops: Int = 1,
    asOfRev: Option[Rev] = None
  ): IO[ExpandResult] = {
    val predicateFilter = predicates.filter(_.nonEmpty) match {
      case Some(ps) =>
        val inList = ps.map(p => s"'${escapeSql(p)}'").mkString(",")
        s" AND predicate IN [$inList]"
      case None => ""
    }

    def buildEdgeQuery(srcOrDst: String): String =
      s"SELECT FROM ix_edges WHERE $srcOrDst = :nodeId AND created_rev <= :rev AND (deleted_rev IS NULL OR :rev < deleted_rev)$predicateFilter"

    def buildBindVars(rev: Rev): Map[String, AnyRef] =
      Map(
        "nodeId" -> nodeId.value.toString.asInstanceOf[AnyRef],
        "rev"    -> Long.box(rev.value).asInstanceOf[AnyRef]
      )

    for {
      resolvedRev <- asOfRev.fold(getLatestRev)(IO.pure)
      bindVars     = buildBindVars(resolvedRev)

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

      neighborIds = allEdges.flatMap { e =>
        if (e.src == nodeId) Vector(e.dst)
        else if (e.dst == nodeId) Vector(e.src)
        else Vector(e.src, e.dst)
      }.distinct

      nodes <- if (neighborIds.isEmpty) IO.pure(Vector.empty[GraphNode])
               else {
                 val idList = neighborIds.map(nid => s"'${nid.value.toString}'").mkString(",")
                 client.query(
                   s"SELECT FROM ix_nodes WHERE logical_id IN [$idList] AND created_rev <= :rev AND (deleted_rev IS NULL OR :rev < deleted_rev)",
                   Map("rev" -> Long.box(resolvedRev.value).asInstanceOf[AnyRef])
                 ).map(_.flatMap(parseNode).toVector)
               }
    } yield ExpandResult(nodes, allEdges)
  }

  override def getClaims(entityId: NodeId): IO[Vector[Claim]] =
    client.query(
      "SELECT FROM ix_claims WHERE entity_id = :entityId AND deleted_rev IS NULL",
      Map("entityId" -> entityId.value.toString.asInstanceOf[AnyRef])
    ).map(_.flatMap(parseClaim).toVector)

  override def getLatestRev: IO[Rev] =
    client.queryOne(
      "SELECT rev FROM ix_revisions WHERE key = :key",
      Map("key" -> "current".asInstanceOf[AnyRef])
    ).map(_.flatMap(_.hcursor.downField("rev").as[Long].toOption).map(Rev(_)).getOrElse(Rev(0L)))

  override def getPatchesForEntity(entityId: NodeId): IO[List[Json]] = {
    val nodeIdStr = entityId.value.toString
    // ArcadeDB can't do nested array filtering like AQL.
    // Fetch all patches and filter in Scala.
    client.query(
      "SELECT FROM ix_patches ORDER BY rev ASC",
      Map.empty
    ).map(_.filter { patchJson =>
      val dataJson = extractPatchData(patchJson)
      dataJson.exists { data =>
        val ops = data.hcursor.downField("ops").focus
          .flatMap(_.asArray)
          .getOrElse(Vector.empty)
        ops.exists { op =>
          val opId = op.hcursor.downField("id").as[String].toOption
          val opEntityId = op.hcursor.downField("entityId").as[String].toOption
          opId.contains(nodeIdStr) || opEntityId.contains(nodeIdStr)
        }
      }
    })
  }

  override def getPatchesBySource(sourceUri: String, extractor: String): IO[Vector[Json]] = {
    // ArcadeDB can't query nested JSON fields. Fetch all patches, filter in Scala.
    client.query(
      "SELECT FROM ix_patches ORDER BY rev DESC",
      Map.empty
    ).map(_.filter { patchJson =>
      val dataJson = extractPatchData(patchJson)
      dataJson.exists { data =>
        val src = data.hcursor.downField("source")
        val uri = src.downField("uri").as[String].toOption
        val ext = src.downField("extractor").as[String].toOption
        uri.contains(sourceUri) && ext.contains(extractor)
      }
    }.toVector)
  }

  override def getChangedEntities(fromRev: Rev, toRev: Rev): IO[Vector[(GraphNode, Option[GraphNode])]] = {
    for {
      // Find all logical_ids that have rows created in the range (fromRev, toRev]
      rows <- client.query(
        "SELECT logical_id FROM ix_nodes WHERE created_rev > :fromRev AND created_rev <= :toRev",
        Map(
          "fromRev" -> Long.box(fromRev.value).asInstanceOf[AnyRef],
          "toRev"   -> Long.box(toRev.value).asInstanceOf[AnyRef]
        )
      )
      logicalIds = rows.flatMap(_.hcursor.get[String]("logical_id").toOption).distinct.toVector
      results <- logicalIds.traverse { lid =>
        val nodeId = NodeId(UUID.fromString(lid))
        for {
          atFrom <- getNode(nodeId, asOfRev = Some(fromRev))
          atTo   <- getNode(nodeId, asOfRev = Some(toRev))
        } yield atTo.map(to => (to, atFrom))
      }
    } yield results.flatten
  }

  override def getDiffSummary(fromRev: Rev, toRev: Rev): IO[Map[String, Int]] = {
    // Get distinct logical_ids changed in the range
    for {
      rows <- client.query(
        "SELECT logical_id FROM ix_nodes WHERE created_rev > :fromRev AND created_rev <= :toRev",
        Map(
          "fromRev" -> Long.box(fromRev.value).asInstanceOf[AnyRef],
          "toRev"   -> Long.box(toRev.value).asInstanceOf[AnyRef]
        )
      )
      logicalIds = rows.flatMap(_.hcursor.get[String]("logical_id").toOption).distinct.toVector
      changes <- logicalIds.traverse { lid =>
        val nodeId = NodeId(UUID.fromString(lid))
        for {
          atFrom <- getNode(nodeId, asOfRev = Some(fromRev))
          atTo   <- getNode(nodeId, asOfRev = Some(toRev))
        } yield {
          if (atFrom.isEmpty && atTo.isDefined) "added"
          else if (atFrom.isDefined && atTo.isEmpty) "removed"
          else "modified"
        }
      }
    } yield changes.groupBy(identity).map { case (k, v) => k -> v.size }
  }

  override def resolvePrefix(prefix: String): IO[Vector[NodeId]] =
    client.query(
      "SELECT logical_id FROM ix_nodes WHERE deleted_rev IS NULL AND logical_id LIKE :pattern",
      Map("pattern" -> s"$prefix%".asInstanceOf[AnyRef])
    ).map(_.flatMap(_.hcursor.get[String]("logical_id").toOption)
      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption.map(NodeId(_)))
      .distinct
      .take(10)
      .toVector
    )

  override def getSourceHashes(sourceUris: Seq[String]): IO[Map[String, String]] = {
    if (sourceUris.isEmpty) IO.pure(Map.empty)
    else {
      // Fetch all patches and filter in Scala
      client.query(
        "SELECT FROM ix_patches ORDER BY rev DESC",
        Map.empty
      ).map { patches =>
        val uriSet = sourceUris.toSet
        val result = scala.collection.mutable.Map[String, String]()
        patches.foreach { patchJson =>
          val dataJson = extractPatchData(patchJson)
          dataJson.foreach { data =>
            val src = data.hcursor.downField("source")
            val uri = src.downField("uri").as[String].toOption
            val hash = src.downField("sourceHash").as[String].toOption
            (uri, hash) match {
              case (Some(u), Some(h)) if uriSet.contains(u) && !result.contains(u) =>
                result(u) = h
              case _ =>
            }
          }
        }
        result.toMap
      }
    }
  }

  override def expandByName(
    name: String,
    direction: Direction,
    predicates: Option[Set[String]] = None,
    kinds: Option[Set[NodeKind]] = None
  ): IO[ExpandResult] = {
    // Step 1: Find target node IDs by name
    val kindFilter = kinds.filter(_.nonEmpty) match {
      case Some(ks) =>
        val inList = ks.map(k => s"'${escapeSql(nodeKindToString(k))}'").mkString(",")
        s" AND kind IN [$inList]"
      case None => ""
    }

    val predicateFilter = predicates.filter(_.nonEmpty) match {
      case Some(ps) =>
        val inList = ps.map(p => s"'${escapeSql(p)}'").mkString(",")
        s" AND predicate IN [$inList]"
      case None => ""
    }

    for {
      // Get target node logical_ids
      targetRows <- client.query(
        s"SELECT logical_id FROM ix_nodes WHERE name = :name AND deleted_rev IS NULL$kindFilter",
        Map("name" -> name.asInstanceOf[AnyRef])
      )
      targetIds = targetRows.flatMap(_.hcursor.get[String]("logical_id").toOption).distinct

      result <- if (targetIds.isEmpty) IO.pure(ExpandResult(Vector.empty, Vector.empty))
      else {
        val idList = targetIds.map(id => s"'$id'").mkString(",")

        // Step 2: Find matching edges
        val dirFilter = direction match {
          case Direction.Out  => s"src IN [$idList]"
          case Direction.In   => s"dst IN [$idList]"
          case Direction.Both => s"(src IN [$idList] OR dst IN [$idList])"
        }

        for {
          edgeRows <- client.query(
            s"SELECT FROM ix_edges WHERE deleted_rev IS NULL AND $dirFilter$predicateFilter",
            Map.empty
          )
          edges = edgeRows.flatMap(parseEdge).toVector

          // Step 3: Collect "other side" node IDs
          targetIdSet = targetIds.toSet
          otherIds = edges.flatMap { e =>
            val srcStr = e.src.value.toString
            val dstStr = e.dst.value.toString
            if (targetIdSet.contains(srcStr)) Vector(e.dst)
            else if (targetIdSet.contains(dstStr)) Vector(e.src)
            else Vector(e.src, e.dst)
          }.distinct

          // Step 4: Fetch other nodes
          nodes <- if (otherIds.isEmpty) IO.pure(Vector.empty[GraphNode])
                   else {
                     val nodeIdList = otherIds.map(nid => s"'${nid.value.toString}'").mkString(",")
                     client.query(
                       s"SELECT FROM ix_nodes WHERE logical_id IN [$nodeIdList] AND deleted_rev IS NULL",
                       Map.empty
                     ).map(_.flatMap(parseNode).toVector)
                   }
        } yield ExpandResult(nodes, edges)
      }
    } yield result
  }

  // ── JSON Parsers ────────────────────────────────────────────────────

  // ArcadeDB returns fields at top level. Provenance fields are stored as
  // individual columns (source_uri, source_hash, extractor, source_type)
  // rather than a nested provenance object.
  // attrs is stored as a JSON string that needs to be parsed.

  private def parseNode(json: Json): Option[GraphNode] = {
    val c = json.hcursor
    val result = for {
      id         <- c.get[String]("logical_id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      kindStr    <- c.get[String]("kind").toOption
      kind       <- NodeKind.decoder.decodeJson(Json.fromString(kindStr)).toOption
      name        = c.get[String]("name").getOrElse("")
      attrsRaw    = c.downField("attrs").focus.getOrElse(Json.obj())
      attrs       = parseAttrsField(attrsRaw)
      provenance <- parseProvenance(Some(json))
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
      id         <- c.get[String]("edge_id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(EdgeId(_))
      src        <- c.get[String]("src").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      dst        <- c.get[String]("dst").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      predicate  <- c.get[String]("predicate").toOption.map(EdgePredicate(_))
      attrsRaw    = c.downField("attrs").focus.getOrElse(Json.obj())
      attrs       = parseAttrsField(attrsRaw)
      provenance <- parseProvenance(Some(json))
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
    } yield GraphEdge(id, src, dst, predicate, attrs, provenance, createdRev, deletedRev)
    if (result.isEmpty) log.warn("Failed to parse edge from JSON: {}", json.noSpaces.take(200))
    result
  }

  private def parseClaim(json: Json): Option[Claim] = {
    val c = json.hcursor
    val result = for {
      // ArcadeDB doesn't have _key. Use @rid as a fallback, or claim_id if set.
      // Since claims are inserted without a claim_id field, we generate one from @rid.
      claimId    <- {
        // Try claim_id first, then fall back to generating from @rid
        c.get[String]("claim_id").toOption
          .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
          .map(ClaimId(_))
          .orElse {
            // Generate a deterministic UUID from the entity_id + field + value combo
            val entityId = c.get[String]("entity_id").toOption.getOrElse("")
            val field = c.get[String]("field").toOption.getOrElse("")
            val value = c.downField("value").focus.map(_.noSpaces).getOrElse("")
            Some(ClaimId(UUID.nameUUIDFromBytes(s"$entityId:$field:$value".getBytes("UTF-8"))))
          }
      }
      entityId   <- c.get[String]("entity_id").toOption
                      .flatMap(s => scala.util.Try(UUID.fromString(s)).toOption)
                      .map(NodeId(_))
      field      <- c.get[String]("field").toOption
      valueRaw    = c.downField("value").focus.getOrElse(Json.Null)
      value       = if (valueRaw.isString) {
                      // Value was stored as a JSON string, try to parse it
                      valueRaw.asString.flatMap(s => parseJson(s).toOption).getOrElse(valueRaw)
                    } else valueRaw
      confidence  = c.get[Double]("confidence").toOption
      statusStr  <- c.get[String]("status").toOption
      status     <- statusStr.toLowerCase match {
                      case "active"    => Some(ClaimStatus.Active)
                      case "stale"     => Some(ClaimStatus.Stale)
                      case "retracted" => Some(ClaimStatus.Retracted)
                      case "retired"   => Some(ClaimStatus.Stale) // retired mapped to stale
                      case _           => None
                    }
      provenance <- parseProvenance(Some(json))
      createdRev <- c.get[Long]("created_rev").toOption.map(Rev(_))
      deletedRev  = c.get[Long]("deleted_rev").toOption.map(Rev(_))
    } yield Claim(claimId, entityId, field, value, confidence, status, provenance, createdRev, deletedRev)
    if (result.isEmpty) log.warn("Failed to parse claim from JSON: {}", json.noSpaces.take(200))
    result
  }

  // In ArcadeDB, provenance is NOT a nested object. The fields are stored at top level.
  private def parseProvenance(jsonOpt: Option[Json]): Option[Provenance] = {
    jsonOpt.flatMap { json =>
      val c = json.hcursor
      // Try nested "provenance" field first (in case it exists), then top-level fields
      val nested = c.downField("provenance").focus
      nested match {
        case Some(prov) if prov.isObject =>
          val pc = prov.hcursor
          for {
            sourceUri  <- pc.get[String]("source_uri").toOption
            sourceHash  = pc.get[String]("source_hash").toOption
            extractor  <- pc.get[String]("extractor").toOption
            stStr      <- pc.get[String]("source_type").toOption
            sourceType <- SourceType.decoder.decodeJson(Json.fromString(stStr)).toOption
            observedAt <- pc.get[String]("observed_at").toOption
                            .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
          } yield Provenance(sourceUri, sourceHash, extractor, sourceType, observedAt)
        case _ =>
          // ArcadeDB top-level fields
          for {
            sourceUri  <- c.get[String]("source_uri").toOption
            sourceHash  = c.get[String]("source_hash").toOption
            extractor  <- c.get[String]("extractor").toOption
            stStr      <- c.get[String]("source_type").toOption
            sourceType <- SourceType.decoder.decodeJson(Json.fromString(stStr)).toOption
          } yield {
            // For ArcadeDB, we use the created_at timestamp or now as observed_at
            val observedAt = c.get[String]("created_at").toOption
              .flatMap(s => scala.util.Try(Instant.parse(s)).toOption)
              .getOrElse(Instant.now())
            Provenance(sourceUri, sourceHash, extractor, sourceType, observedAt)
          }
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Parse attrs field: could be a JSON string or a JSON object. */
  private def parseAttrsField(raw: Json): Json = {
    if (raw.isString) {
      raw.asString.flatMap(s => parseJson(s).toOption).getOrElse(Json.obj())
    } else {
      raw
    }
  }

  /** Extract patch data from a patch row. Data may be stored as a string. */
  private def extractPatchData(patchJson: Json): Option[Json] = {
    val dataField = patchJson.hcursor.downField("data").focus
    dataField.flatMap { d =>
      if (d.isString) d.asString.flatMap(s => parseJson(s).toOption)
      else if (d.isObject) Some(d)
      else None
    }
  }

  /** Deduplicate (id, weight) pairs keeping the highest weight per id. */
  private def deduplicateByMaxWeight(scored: List[(String, Int)]): Map[String, Int] =
    scored.groupBy(_._1).map { case (id, pairs) => id -> pairs.map(_._2).max }

  /** Fetch full nodes by logical_id list, applying kind and language filters. */
  private def fetchAndFilterNodes(
    ids: Vector[String],
    kind: Option[String],
    language: Option[String],
    weightMap: Map[String, Int]
  ): IO[Vector[GraphNode]] = {
    if (ids.isEmpty) IO.pure(Vector.empty)
    else {
      val idList = ids.map(id => s"'${escapeSql(id)}'").mkString(",")
      val kindFilter = kind.map(k => s" AND kind = '${escapeSql(k)}'").getOrElse("")
      client.query(
        s"SELECT FROM ix_nodes WHERE logical_id IN [$idList] AND deleted_rev IS NULL$kindFilter",
        Map.empty
      ).map { results =>
        val parsed = results.flatMap(parseNode).toVector
        language match {
          case Some(l) =>
            val lower = l.toLowerCase
            parsed.filter(n => n.provenance.sourceUri.toLowerCase.contains(lower))
          case None => parsed
        }
      }
    }
  }

  private def isSymbolKind(kind: NodeKind): Boolean = kind match {
    case NodeKind.Function | NodeKind.Method | NodeKind.Class |
         NodeKind.Trait | NodeKind.Object | NodeKind.Interface => true
    case _ => false
  }

  private def escapeSql(s: String): String = s.replace("'", "''")

  private def nodeKindToString(nk: NodeKind): String =
    NodeKind.encoder.apply(nk).asString.getOrElse(nk.toString)
}
