package ix.memory.ingestion

import java.time.Instant
import java.util.UUID

import io.circe.Json

import ix.memory.model._

object GraphPatchBuilder {

  /**
   * Build a GraphPatch from a ParseResult and file metadata.
   *
   * Uses deterministic UUID generation (UUID v3 (MD5-based nameUUID)) so that
   * re-parsing the same file produces the same node/edge IDs, enabling
   * idempotent upserts.
   */
  def build(
    filePath:   String,
    sourceHash: Option[String],
    parseResult: ParseResult
  ): GraphPatch = {

    def nodeIdFor(name: String): NodeId =
      NodeId(UUID.nameUUIDFromBytes(s"$filePath:$name".getBytes("UTF-8")))

    def edgeIdFor(src: String, dst: String, predicate: String): EdgeId =
      EdgeId(UUID.nameUUIDFromBytes(s"$filePath:$src:$dst:$predicate".getBytes("UTF-8")))

    val extractor = if (filePath.endsWith(".py")) "tree-sitter-python/1.0"
                    else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) "typescript-parser/1.0"
                    else if (filePath.endsWith(".scala") || filePath.endsWith(".sc")) "scala-parser/1.0"
                    else if (filePath.endsWith(".go")) "tree-sitter-go/1.0"
                    else if (filePath.endsWith(".json") || filePath.endsWith(".yaml") || filePath.endsWith(".yml") || filePath.endsWith(".toml")) "config-parser/1.0"
                    else if (filePath.endsWith(".md")) "markdown-parser/1.0"
                    else "unknown-parser/1.0"

    val nodeOps = parseResult.entities.map { e =>
      val baseAttrs = e.attrs +
        ("line_start" -> Json.fromInt(e.lineStart)) +
        ("line_end"   -> Json.fromInt(e.lineEnd))
      val attrsWithFp = e.contentFingerprint match {
        case Some(fp) => baseAttrs + ("content_fingerprint" -> Json.fromString(fp))
        case None     => baseAttrs
      }
      PatchOp.UpsertNode(nodeIdFor(e.name), e.kind, e.name, attrsWithFp)
    }

    val edgeOps = parseResult.relationships.map { r =>
      PatchOp.UpsertEdge(
        edgeIdFor(r.srcName, r.dstName, r.predicate),
        nodeIdFor(r.srcName),
        nodeIdFor(r.dstName),
        EdgePredicate(r.predicate),
        Map.empty
      )
    }

    // Generate claims so the confidence/conflict engine has data to operate on.
    val relationshipClaims = parseResult.relationships.map { r =>
      PatchOp.AssertClaim(
        entityId   = nodeIdFor(r.srcName),
        field      = s"${r.predicate.toLowerCase}:${r.dstName}",
        value      = Json.fromString(r.dstName),
        confidence = None // will be computed at query time
      )
    }

    val attributeClaims = parseResult.entities.flatMap { e =>
      e.attrs.flatMap { case (key, value) =>
        Vector(PatchOp.AssertClaim(
          entityId   = nodeIdFor(e.name),
          field      = key,
          value      = value,
          confidence = None
        ))
      }
    }

    val claimOps = relationshipClaims ++ attributeClaims
    val allOps   = nodeOps ++ edgeOps ++ claimOps

    val sourceType = if (filePath.endsWith(".py") || filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".scala") || filePath.endsWith(".sc") || filePath.endsWith(".go")) SourceType.Code
                     else if (filePath.endsWith(".json") || filePath.endsWith(".yaml") || filePath.endsWith(".yml") || filePath.endsWith(".toml")) SourceType.Config
                     else if (filePath.endsWith(".md")) SourceType.Doc
                     else SourceType.Code

    GraphPatch(
      patchId   = PatchId(UUID.randomUUID()),
      actor     = "ix/ingestion",
      timestamp = Instant.now(),
      source    = PatchSource(filePath, sourceHash, extractor, sourceType),
      baseRev   = Rev(0L),
      ops       = allOps,
      replaces  = Vector.empty,
      intent    = Some(s"Parsed $filePath")
    )
  }
}
