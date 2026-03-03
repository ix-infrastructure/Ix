package ix.memory.ingestion

import java.time.Instant
import java.util.UUID

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

    GraphPatch(
      patchId   = PatchId(UUID.randomUUID()),
      actor     = "ix/ingestion",
      timestamp = Instant.now(),
      source    = PatchSource(filePath, sourceHash, "tree-sitter-python/1.0", SourceType.Code),
      baseRev   = Rev(0L),
      ops       = nodeOps ++ edgeOps,
      replaces  = Vector.empty,
      intent    = Some(s"Parsed $filePath")
    )
  }
}
