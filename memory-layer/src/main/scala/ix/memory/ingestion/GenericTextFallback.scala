package ix.memory.ingestion

import io.circe.Json
import ix.memory.model.NodeKind

object GenericTextFallback {
  private val PreviewLimit = 240

  def parse(fileName: String, source: String): ParseResult = {
    val lines = if (source.isEmpty) 1 else source.count(_ == '\n') + 1
    val preview = source.linesIterator.find(_.trim.nonEmpty).map(_.trim.take(PreviewLimit))

    val attrs = Map(
      "file_name" -> Json.fromString(fileName),
      "line_count" -> Json.fromInt(lines)
    ) ++ preview.filter(_.nonEmpty).map(value => "preview" -> Json.fromString(value))

    ParseResult(
      entities = Vector(
        ParsedEntity(
          name = fileName,
          kind = NodeKind.File,
          attrs = attrs,
          lineStart = 1,
          lineEnd = lines,
          contentFingerprint = Some(Fingerprint.compute(fileName, source))
        )
      ),
      relationships = Vector.empty
    )
  }
}
