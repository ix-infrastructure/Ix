package ix.memory.db

import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.traverse._
import cats.syntax.foldable._
import cats.instances.vector._
import io.circe.syntax._
import io.circe.Json

import ix.memory.model._

class ArangoGraphWriteApi(client: ArangoClient) extends GraphWriteApi {

  override def commitPatch(patch: GraphPatch): IO[CommitResult] =
    for {
      // Step 1: Check idempotency — has this patch_id already been applied?
      idempotent <- checkIdempotency(patch.patchId, patch.tenant)
      result     <- idempotent match {
        case Some(storedRev) =>
          IO.pure(CommitResult(storedRev, CommitStatus.Idempotent))
        case None =>
          doCommit(patch)
      }
    } yield result

  private def checkIdempotency(patchId: PatchId, tenant: TenantId): IO[Option[Rev]] =
    client.queryOne(
      """FOR ik IN idempotency_keys
        |  FILTER ik.key == @key
        |  RETURN ik.rev""".stripMargin,
      Map("key" -> idempotencyKey(patchId, tenant).asInstanceOf[AnyRef])
    ).map(_.flatMap(_.as[Long].toOption).map(Rev(_)))

  private def idempotencyKey(patchId: PatchId, tenant: TenantId): String =
    s"${tenant.value}:${patchId.value}"

  private def doCommit(patch: GraphPatch): IO[CommitResult] =
    for {
      // Step 2: Load latest_rev for tenant
      latestRev <- loadLatestRev(patch.tenant)

      // Step 3: Check baseRev (if > 0, must match latest)
      result <- {
        if (patch.baseRev.value > 0L && patch.baseRev.value != latestRev) {
          IO.pure(CommitResult(Rev(latestRev), CommitStatus.BaseRevMismatch))
        } else {
          val newRev = latestRev + 1L
          for {
            // Step 5: Execute each op
            _ <- patch.ops.traverse_(op => executeOp(op, patch, newRev))
            // Step 6: Store patch
            _ <- storePatch(patch, newRev)
            // Step 7: Store idempotency key
            _ <- storeIdempotencyKey(patch.patchId, patch.tenant, newRev)
            // Step 8: Update tenant revision
            _ <- updateTenantRevision(patch.tenant, newRev)
          } yield CommitResult(Rev(newRev), CommitStatus.Ok)
        }
      }
    } yield result

  private def loadLatestRev(tenant: TenantId): IO[Long] =
    client.queryOne(
      """FOR r IN revisions
        |  FILTER r._key == @key
        |  RETURN r.rev""".stripMargin,
      Map("key" -> tenant.value.toString.asInstanceOf[AnyRef])
    ).map(_.flatMap(_.as[Long].toOption).getOrElse(0L))

  private def executeOp(op: PatchOp, patch: GraphPatch, newRev: Long): IO[Unit] = op match {
    case PatchOp.UpsertNode(id, kind, name, attrs) =>
      val now = Instant.now().toString
      val provenanceJson = buildProvenance(patch)
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      client.execute(
        """UPSERT { _key: @key }
          |  INSERT {
          |    _key: @key,
          |    id: @id,
          |    kind: @kind,
          |    name: @name,
          |    tenant: @tenant,
          |    attrs: @attrs,
          |    created_rev: @created_rev,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    created_at: @now,
          |    updated_at: @now
          |  }
          |  UPDATE {
          |    kind: @kind,
          |    name: @name,
          |    attrs: @attrs,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    updated_at: @now
          |  }
          |  IN nodes""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "id"          -> id.value.toString.asInstanceOf[AnyRef],
          "kind"        -> nodeKindToString(kind).asInstanceOf[AnyRef],
          "name"        -> name.asInstanceOf[AnyRef],
          "tenant"      -> patch.tenant.value.toString.asInstanceOf[AnyRef],
          "attrs"       -> parseToJavaMap(attrsJson).asInstanceOf[AnyRef],
          "created_rev" -> Long.box(newRev).asInstanceOf[AnyRef],
          "provenance"  -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
          "now"         -> now.asInstanceOf[AnyRef]
        )
      )

    case PatchOp.UpsertEdge(id, src, dst, predicate, attrs) =>
      val now = Instant.now().toString
      val provenanceJson = buildProvenance(patch)
      val attrsJson = Json.obj(attrs.toSeq.map { case (k, v) => k -> v }: _*).noSpaces
      client.execute(
        """UPSERT { _key: @key }
          |  INSERT {
          |    _key: @key,
          |    _from: @from,
          |    _to: @to,
          |    id: @id,
          |    src: @src,
          |    dst: @dst,
          |    predicate: @predicate,
          |    tenant: @tenant,
          |    attrs: @attrs,
          |    created_rev: @created_rev,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    created_at: @now,
          |    updated_at: @now
          |  }
          |  UPDATE {
          |    _from: @from,
          |    _to: @to,
          |    src: @src,
          |    dst: @dst,
          |    predicate: @predicate,
          |    attrs: @attrs,
          |    deleted_rev: null,
          |    provenance: @provenance,
          |    updated_at: @now
          |  }
          |  IN edges""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "id"          -> id.value.toString.asInstanceOf[AnyRef],
          "from"        -> s"nodes/${src.value}".asInstanceOf[AnyRef],
          "to"          -> s"nodes/${dst.value}".asInstanceOf[AnyRef],
          "src"         -> src.value.toString.asInstanceOf[AnyRef],
          "dst"         -> dst.value.toString.asInstanceOf[AnyRef],
          "predicate"   -> predicate.value.asInstanceOf[AnyRef],
          "tenant"      -> patch.tenant.value.toString.asInstanceOf[AnyRef],
          "attrs"       -> parseToJavaMap(attrsJson).asInstanceOf[AnyRef],
          "created_rev" -> Long.box(newRev).asInstanceOf[AnyRef],
          "provenance"  -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef],
          "now"         -> now.asInstanceOf[AnyRef]
        )
      )

    case PatchOp.DeleteNode(id) =>
      client.execute(
        """FOR n IN nodes
          |  FILTER n._key == @key
          |  UPDATE n WITH { deleted_rev: @deleted_rev } IN nodes""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )

    case PatchOp.DeleteEdge(id) =>
      client.execute(
        """FOR e IN edges
          |  FILTER e._key == @key
          |  UPDATE e WITH { deleted_rev: @deleted_rev } IN edges""".stripMargin,
        Map(
          "key"         -> id.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )

    case PatchOp.AssertClaim(entityId, field, value, confidence) =>
      val claimKey = UUID.randomUUID().toString
      val provenanceJson = buildProvenance(patch)
      client.execute(
        """INSERT {
          |  _key: @key,
          |  entity_id: @entity_id,
          |  field: @field,
          |  value: @value,
          |  confidence: @confidence,
          |  status: @status,
          |  tenant: @tenant,
          |  created_rev: @created_rev,
          |  deleted_rev: null,
          |  provenance: @provenance
          |} INTO claims""".stripMargin,
        Map(
          "key"         -> claimKey.asInstanceOf[AnyRef],
          "entity_id"   -> entityId.value.toString.asInstanceOf[AnyRef],
          "field"       -> field.asInstanceOf[AnyRef],
          "value"       -> jsonToJava(value).asInstanceOf[AnyRef],
          "confidence"  -> confidence.map(Double.box).orNull.asInstanceOf[AnyRef],
          "status"      -> "active".asInstanceOf[AnyRef],
          "tenant"      -> patch.tenant.value.toString.asInstanceOf[AnyRef],
          "created_rev" -> Long.box(newRev).asInstanceOf[AnyRef],
          "provenance"  -> parseToJavaMap(provenanceJson.noSpaces).asInstanceOf[AnyRef]
        )
      )

    case PatchOp.RetractClaim(claimId) =>
      client.execute(
        """FOR c IN claims
          |  FILTER c._key == @key
          |  UPDATE c WITH { status: "retracted", deleted_rev: @deleted_rev } IN claims""".stripMargin,
        Map(
          "key"         -> claimId.value.toString.asInstanceOf[AnyRef],
          "deleted_rev" -> Long.box(newRev).asInstanceOf[AnyRef]
        )
      )
  }

  private def storePatch(patch: GraphPatch, newRev: Long): IO[Unit] = {
    val patchJson = patch.asJson.noSpaces
    client.execute(
      """INSERT {
        |  _key: @key,
        |  patch_id: @patch_id,
        |  tenant: @tenant,
        |  rev: @rev,
        |  data: @data
        |} INTO patches""".stripMargin,
      Map(
        "key"      -> s"${patch.tenant.value}:${patch.patchId.value}".asInstanceOf[AnyRef],
        "patch_id" -> patch.patchId.value.toString.asInstanceOf[AnyRef],
        "tenant"   -> patch.tenant.value.toString.asInstanceOf[AnyRef],
        "rev"      -> Long.box(newRev).asInstanceOf[AnyRef],
        "data"     -> parseToJavaMap(patchJson).asInstanceOf[AnyRef]
      )
    )
  }

  private def storeIdempotencyKey(patchId: PatchId, tenant: TenantId, newRev: Long): IO[Unit] =
    client.execute(
      """INSERT {
        |  key: @key,
        |  rev: @rev,
        |  created_at: DATE_NOW() / 1000
        |} INTO idempotency_keys""".stripMargin,
      Map(
        "key" -> idempotencyKey(patchId, tenant).asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      )
    )

  private def updateTenantRevision(tenant: TenantId, newRev: Long): IO[Unit] =
    client.execute(
      """UPSERT { _key: @key }
        |  INSERT { _key: @key, rev: @rev }
        |  UPDATE { rev: @rev }
        |  IN revisions""".stripMargin,
      Map(
        "key" -> tenant.value.toString.asInstanceOf[AnyRef],
        "rev" -> Long.box(newRev).asInstanceOf[AnyRef]
      )
    )

  private def buildProvenance(patch: GraphPatch): Json =
    Json.obj(
      "source_uri"  -> Json.fromString(patch.source.uri),
      "source_hash" -> patch.source.sourceHash.fold(Json.Null)(Json.fromString),
      "extractor"   -> Json.fromString(patch.source.extractor),
      "source_type" -> Json.fromString(sourceTypeToString(patch.source.sourceType)),
      "observed_at" -> Json.fromString(patch.timestamp.toString)
    )

  private def sourceTypeToString(st: SourceType): String = st match {
    case SourceType.Code     => "code"
    case SourceType.Config   => "config"
    case SourceType.Doc      => "doc"
    case SourceType.Test     => "test"
    case SourceType.Schema   => "schema"
    case SourceType.Commit   => "commit"
    case SourceType.Comment  => "comment"
    case SourceType.Inferred => "inferred"
    case SourceType.Human    => "human"
  }

  private def nodeKindToString(nk: NodeKind): String = nk match {
    case NodeKind.Module      => "module"
    case NodeKind.File        => "file"
    case NodeKind.Class       => "class"
    case NodeKind.Function    => "function"
    case NodeKind.Variable    => "variable"
    case NodeKind.Config      => "config"
    case NodeKind.ConfigEntry => "config_entry"
    case NodeKind.Service     => "service"
    case NodeKind.Endpoint    => "endpoint"
  }

  /** Convert a JSON string into a java.util.Map for use as an ArangoDB bind variable. */
  private def parseToJavaMap(jsonStr: String): java.util.Map[String, AnyRef] = {
    val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
    mapper.readValue(jsonStr, classOf[java.util.Map[String, AnyRef]])
  }

  /** Convert a circe Json value to a Java object suitable for ArangoDB bind variables. */
  private def jsonToJava(json: Json): AnyRef = {
    val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
    mapper.readValue(json.noSpaces, classOf[AnyRef])
  }
}
