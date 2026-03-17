package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * Markdown parser that extracts structural entities from `.md` files.
 *
 * Each heading becomes a Doc entity with attrs for `level`, `title`, and `content`.
 * Content captures all non-header lines in the section, up to 2000 characters.
 * A top-level File entity is also emitted, with CONTAINS edges to each section.
 */
class MarkdownParser extends Parser {

  private val HeadingPattern: Regex = """^(#{1,6})\s+(.+)$""".r

  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    // -- File entity --
    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("markdown")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    // Collect headings with their line indices
    val headings: Vector[(Int, Int, String)] = lines.zipWithIndex.flatMap { case (line, idx) =>
      HeadingPattern.findFirstMatchIn(line.trim).map { m =>
        val level = m.group(1).length
        val title = m.group(2).trim
        (idx, level, title)
      }
    }.toVector

    var entities = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    for (i <- headings.indices) {
      val (startIdx, level, title) = headings(i)
      val endIdx = if (i + 1 < headings.length) headings(i + 1)._1 else lines.length

      val content = extractContent(lines, startIdx, endIdx)

      val entity = ParsedEntity(
        name      = title,
        kind      = NodeKind.Doc,
        attrs     = Map(
          "level"   -> Json.fromInt(level),
          "title"   -> Json.fromString(title),
          "content" -> Json.fromString(content)
        ),
        lineStart = startIdx + 1,
        lineEnd   = endIdx
      )

      entities = entities :+ entity
      relationships = relationships :+ ParsedRelationship(fileName, title, "CONTAINS")
    }

    ParseResult(entities, relationships)
  }

  /**
   * Extract content from all non-header lines in the section, up to 2000 characters.
   */
  private def extractContent(lines: Array[String], startIdx: Int, endIdx: Int): String = {
    val contentLines = lines.slice(startIdx + 1, endIdx).filterNot { line =>
      HeadingPattern.findFirstMatchIn(line.trim).isDefined
    }
    contentLines.mkString("\n").trim.take(2000)
  }
}
