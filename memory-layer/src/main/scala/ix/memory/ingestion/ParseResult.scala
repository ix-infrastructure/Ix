package ix.memory.ingestion

import ix.memory.model.NodeKind
import io.circe.Json

case class ParsedEntity(
  name:      String,
  kind:      NodeKind,
  attrs:     Map[String, Json],
  lineStart: Int,
  lineEnd:   Int,
  contentFingerprint: Option[String] = None
)

case class ParsedRelationship(
  srcName:   String,
  dstName:   String,
  predicate: String
)

case class ParseResult(
  entities:      Vector[ParsedEntity],
  relationships: Vector[ParsedRelationship]
)
