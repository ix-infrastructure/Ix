package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

/**
 * Parser for configuration files (JSON, YAML, TOML).
 *
 * Flattens nested structures into dot-path entries so that each leaf value
 * becomes a ConfigEntry node with a meaningful value (never "{" or "[").
 */
class ConfigParser extends Parser {

  private val JsonExtensions = Set(".json")
  private val YamlExtensions = Set(".yaml", ".yml")
  private val TomlExtensions = Set(".toml")

  def canParse(fileName: String): Boolean = {
    val lower = fileName.toLowerCase
    (JsonExtensions ++ YamlExtensions ++ TomlExtensions).exists(ext => lower.endsWith(ext))
  }

  def parse(fileName: String, source: String): ParseResult = {
    val lower = fileName.toLowerCase

    val entries: Vector[(String, String, Int)] =
      if (JsonExtensions.exists(ext => lower.endsWith(ext))) parseJson(source)
      else if (YamlExtensions.exists(ext => lower.endsWith(ext))) parseYaml(source)
      else if (TomlExtensions.exists(ext => lower.endsWith(ext))) parseToml(source)
      else Vector.empty

    buildResult(fileName, source, entries)
  }

  // ---------------------------------------------------------------------------
  // Result builder
  // ---------------------------------------------------------------------------

  private def buildResult(
    fileName: String,
    source:   String,
    entries:  Vector[(String, String, Int)]
  ): ParseResult = {
    val lines = source.split("\n", -1)

    val configEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.Config,
      attrs     = Map("format" -> Json.fromString(detectFormat(fileName))),
      lineStart = 1,
      lineEnd   = lines.length
    )

    val entryEntities = entries.map { case (key, value, line) =>
      ParsedEntity(
        name      = key,
        kind      = NodeKind.ConfigEntry,
        attrs     = Map("value" -> Json.fromString(value)),
        lineStart = line,
        lineEnd   = line
      )
    }

    val relationships = entries.map { case (key, _, _) =>
      ParsedRelationship(fileName, key, "DEFINES")
    }

    ParseResult(
      entities      = configEntity +: entryEntities,
      relationships = relationships
    )
  }

  private def detectFormat(fileName: String): String = {
    val lower = fileName.toLowerCase
    if (JsonExtensions.exists(ext => lower.endsWith(ext))) "json"
    else if (YamlExtensions.exists(ext => lower.endsWith(ext))) "yaml"
    else if (TomlExtensions.exists(ext => lower.endsWith(ext))) "toml"
    else "unknown"
  }

  // ---------------------------------------------------------------------------
  // JSON parsing — Circe-based with flattening
  // ---------------------------------------------------------------------------

  private def parseJson(source: String): Vector[(String, String, Int)] = {
    io.circe.parser.parse(source) match {
      case Right(json) => flattenJson("", json, 1)
      case Left(_)     => regexParseJson(source)
    }
  }

  private def flattenJson(prefix: String, json: io.circe.Json, line: Int): Vector[(String, String, Int)] = {
    json.fold(
      jsonNull    = Vector.empty,
      jsonBoolean = b => Vector((prefix, b.toString, line)),
      jsonNumber  = n => Vector((prefix, n.toString, line)),
      jsonString  = s => Vector((prefix, s, line)),
      jsonArray   = arr => arr.zipWithIndex.flatMap { case (v, i) =>
        val key = if (prefix.isEmpty) s"[$i]" else s"$prefix[$i]"
        flattenJson(key, v, line)
      }.toVector,
      jsonObject  = obj => obj.toVector.flatMap { case (k, v) =>
        val key = if (prefix.isEmpty) k else s"$prefix.$k"
        v.fold(
          jsonNull    = Vector((key, "null", line)),
          jsonBoolean = b => Vector((key, b.toString, line)),
          jsonNumber  = n => Vector((key, n.toString, line)),
          jsonString  = s => Vector((key, s, line)),
          jsonArray   = _ => flattenJson(key, v, line),
          jsonObject  = _ => flattenJson(key, v, line)
        )
      }
    )
  }

  /** Regex fallback for malformed JSON */
  private def regexParseJson(source: String): Vector[(String, String, Int)] = {
    val KvPattern = """"([^"]+)"\s*:\s*"([^"]*)"""".r
    val lines = source.split("\n", -1)
    lines.zipWithIndex.flatMap { case (line, idx) =>
      KvPattern.findAllMatchIn(line).map { m =>
        (m.group(1), m.group(2), idx + 1)
      }
    }.toVector
  }

  // ---------------------------------------------------------------------------
  // YAML parsing — indentation-aware
  // ---------------------------------------------------------------------------

  private def parseYaml(source: String): Vector[(String, String, Int)] = {
    val lines = source.split("\n", -1)
    val result = Vector.newBuilder[(String, String, Int)]
    val stack = scala.collection.mutable.Stack.empty[(Int, String)] // (indent, prefix)

    val KvWithValue = """^([a-zA-Z_][\w.-]*)\s*:\s*(.+)$""".r
    val KvNoValue   = """^([a-zA-Z_][\w.-]*)\s*:\s*$""".r

    lines.zipWithIndex.foreach { case (line, idx) =>
      val trimmed = line.trim
      if (!trimmed.startsWith("#") && trimmed.nonEmpty) {
        val indent = line.takeWhile(_ == ' ').length
        trimmed match {
          case KvWithValue(key, value) =>
            while (stack.nonEmpty && stack.top._1 >= indent) stack.pop()
            val fullKey = if (stack.nonEmpty) s"${stack.top._2}.$key" else key
            result += ((fullKey, value.trim, idx + 1))
          case KvNoValue(key) =>
            while (stack.nonEmpty && stack.top._1 >= indent) stack.pop()
            val fullKey = if (stack.nonEmpty) s"${stack.top._2}.$key" else key
            stack.push((indent, fullKey))
          case _ =>
            // skip list items, comments, etc.
        }
      }
    }
    result.result()
  }

  // ---------------------------------------------------------------------------
  // TOML parsing — section-aware
  // ---------------------------------------------------------------------------

  private def parseToml(source: String): Vector[(String, String, Int)] = {
    val lines = source.split("\n", -1)
    val result = Vector.newBuilder[(String, String, Int)]
    var currentSection = ""

    val SectionPattern = """^\[([^\]]+)\]""".r
    val KvPattern      = """^([a-zA-Z_][\w.-]*)\s*=\s*(.+)$""".r

    lines.zipWithIndex.foreach { case (line, idx) =>
      val trimmed = line.trim
      if (!trimmed.startsWith("#") && trimmed.nonEmpty) {
        trimmed match {
          case SectionPattern(section) =>
            currentSection = section
          case KvPattern(key, value) =>
            val fullKey = if (currentSection.isEmpty) key else s"$currentSection.$key"
            val cleanValue = value.trim.stripPrefix("\"").stripSuffix("\"")
            result += ((fullKey, cleanValue, idx + 1))
          case _ =>
        }
      }
    }
    result.result()
  }
}
