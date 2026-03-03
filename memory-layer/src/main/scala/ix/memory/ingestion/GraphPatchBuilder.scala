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
      EdgeId(UUID.nameUUIDFromBytes(s"$src:$dst:$predicate".getBytes("UTF-8")))

    val extractor = if (filePath.endsWith(".py")) "tree-sitter-python/1.0"
                    else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) "typescript-parser/1.0"
                    else "unknown-parser/1.0"

    val nodeOps = parseResult.entities.map { e =>
      PatchOp.UpsertNode(nodeIdFor(e.name), e.kind, e.name, e.attrs)
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
          value      = Json.fromString(value.noSpaces),
          confidence = None
        ))
      }
    }

    val claimOps = relationshipClaims ++ attributeClaims
    val allOps   = nodeOps ++ edgeOps ++ claimOps

    GraphPatch(
      patchId   = PatchId(UUID.randomUUID()),
      actor     = "ix/ingestion",
      timestamp = Instant.now(),
      source    = PatchSource(filePath, sourceHash, extractor, SourceType.Code),
      baseRev   = Rev(0L),
      ops       = allOps,
      replaces  = Vector.empty,
      intent    = Some(s"Parsed $filePath")
    )
  }
}
