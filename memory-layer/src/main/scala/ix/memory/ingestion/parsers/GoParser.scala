package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * Regex-based Go source parser (fallback for when tree-sitter is unavailable).
 * Extracts: functions, methods, structs, interfaces, type declarations,
 * imports, const/var declarations, and basic call edges.
 */
class GoParser extends Parser {

  private val PackagePattern: Regex    = """^\s*package\s+(\w+)""".r
  private val FuncPattern: Regex       = """^\s*func\s+(\w+)\s*(?:\[.*?\])?\s*\(""".r
  private val MethodPattern: Regex     = """^\s*func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*(?:\[.*?\])?\s*\(""".r
  private val StructPattern: Regex     = """^\s*type\s+(\w+)\s+struct\s*\{""".r
  private val InterfacePattern: Regex  = """^\s*type\s+(\w+)\s+interface\s*\{""".r
  private val TypeAliasPattern: Regex  = """^\s*type\s+(\w+)\s*=\s*(.+)""".r
  private val NamedTypePattern: Regex  = """^\s*type\s+(\w+)\s+(\w+)""".r
  private val ImportSinglePattern: Regex = """^\s*import\s+"([^"]+)"""".r
  private val ImportGroupStart: Regex  = """^\s*import\s*\(""".r
  private val ImportSpecPattern: Regex = """^\s*(?:(\w+|\.)\s+)?"([^"]+)"""".r
  private val ConstPattern: Regex      = """^\s*const\s+(\w+)\s""".r
  private val VarPattern: Regex        = """^\s*var\s+(\w+)\s""".r
  private val ConstGroupStart: Regex   = """^\s*const\s*\(""".r
  private val VarGroupStart: Regex     = """^\s*var\s*\(""".r
  private val ConstSpecPattern: Regex  = """^\s*(\w+)""".r
  private val CallPattern: Regex       = """\b(\w+)\s*\(""".r

  private val GoBuiltins: Set[String] = Set(
    "make", "len", "cap", "append", "copy", "close", "delete",
    "complex", "real", "imag", "new", "panic", "recover",
    "print", "println", "error", "string", "int", "float64",
    "bool", "byte", "rune", "nil", "true", "false", "iota",
    "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
    "float32", "complex64", "complex128", "any", "comparable"
  )

  private val GoKeywords: Set[String] = Set(
    "break", "case", "chan", "const", "continue", "default", "defer",
    "else", "fallthrough", "for", "func", "go", "goto", "if",
    "import", "interface", "map", "package", "range", "return",
    "select", "struct", "switch", "type", "var"
  )

  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    var fileAttrs: Map[String, Json] = Map("language" -> Json.fromString("go"))
    var entities      = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    // Track type ranges for containment
    var typeRanges = Vector.empty[(String, Int, Int)]

    var i = 0
    while (i < lines.length) {
      val line = lines(i)
      val lineNum = i + 1
      val trimmed = line.trim

      // Skip comments
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        i += 1
      } else {
        var handled = false

        // Package
        if (!handled) {
          PackagePattern.findFirstMatchIn(line).foreach { m =>
            fileAttrs = fileAttrs + ("package" -> Json.fromString(m.group(1)))
            handled = true
          }
        }

        // Method (must check before function)
        if (!handled) {
          MethodPattern.findFirstMatchIn(line).foreach { m =>
            val receiverType = m.group(1)
            val methodName = m.group(2)
            val endLine = findBraceBlockEnd(lines, i).getOrElse(lineNum)
            val sig = trimmed.replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val bodyText = lines.slice(i, endLine).mkString("\n")
            val fp = Fingerprint.compute(sig, bodyText)
            val exported = methodName.nonEmpty && methodName.head.isUpper

            entities = entities :+ ParsedEntity(
              name      = methodName,
              kind      = NodeKind.Method,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "summary"    -> Json.fromString(sig),
                "signature"  -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported),
                "receiver"   -> Json.fromString(receiverType)
              ),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(receiverType, methodName, "CONTAINS")

            // Extract calls
            relationships = relationships ++ extractCalls(lines, i, endLine, methodName)

            i = endLine
            handled = true
          }
        }

        // Function
        if (!handled) {
          FuncPattern.findFirstMatchIn(line).foreach { m =>
            val funcName = m.group(1)
            val endLine = findBraceBlockEnd(lines, i).getOrElse(lineNum)
            val sig = trimmed.replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val bodyText = lines.slice(i, endLine).mkString("\n")
            val fp = Fingerprint.compute(sig, bodyText)
            val exported = funcName.nonEmpty && funcName.head.isUpper

            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = NodeKind.Function,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "summary"    -> Json.fromString(sig),
                "signature"  -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")

            // Extract calls
            relationships = relationships ++ extractCalls(lines, i, endLine, funcName)

            i = endLine
            handled = true
          }
        }

        // Struct
        if (!handled) {
          StructPattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            val endLine = findBraceBlockEnd(lines, i).getOrElse(lineNum)
            val sig = trimmed.replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val bodyText = lines.slice(i, endLine).mkString("\n")
            val fp = Fingerprint.compute(sig, bodyText)
            val exported = name.nonEmpty && name.head.isUpper

            entities = entities :+ ParsedEntity(
              name      = name,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString("struct"),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
            typeRanges = typeRanges :+ (name, lineNum, endLine)

            i = endLine
            handled = true
          }
        }

        // Interface
        if (!handled) {
          InterfacePattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            val endLine = findBraceBlockEnd(lines, i).getOrElse(lineNum)
            val sig = trimmed.replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val bodyText = lines.slice(i, endLine).mkString("\n")
            val fp = Fingerprint.compute(sig, bodyText)
            val exported = name.nonEmpty && name.head.isUpper

            entities = entities :+ ParsedEntity(
              name      = name,
              kind      = NodeKind.Interface,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString("interface"),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
            typeRanges = typeRanges :+ (name, lineNum, endLine)

            i = endLine
            handled = true
          }
        }

        // Type alias
        if (!handled) {
          TypeAliasPattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            val exported = name.nonEmpty && name.head.isUpper
            val sig = trimmed.take(120)
            val fp = Fingerprint.compute(sig, sig)

            entities = entities :+ ParsedEntity(
              name      = name,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString("type_alias"),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = lineNum,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
            handled = true
          }
        }

        // Named type (must be after struct/interface/alias checks)
        if (!handled) {
          NamedTypePattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            val baseType = m.group(2)
            if (baseType != "struct" && baseType != "interface") {
              val exported = name.nonEmpty && name.head.isUpper
              val sig = trimmed.take(120)
              val fp = Fingerprint.compute(sig, sig)

              entities = entities :+ ParsedEntity(
                name      = name,
                kind      = NodeKind.Class,
                attrs     = Map(
                  "language"   -> Json.fromString("go"),
                  "go_kind"    -> Json.fromString("named_type"),
                  "signature"  -> Json.fromString(sig),
                  "summary"    -> Json.fromString(sig),
                  "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                  "exported"   -> Json.fromBoolean(exported)
                ),
                lineStart = lineNum,
                lineEnd   = lineNum,
                contentFingerprint = Some(fp)
              )
              relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
              handled = true
            }
          }
        }

        // Import group
        if (!handled) {
          ImportGroupStart.findFirstMatchIn(line).foreach { _ =>
            i += 1
            while (i < lines.length && !lines(i).trim.startsWith(")")) {
              ImportSpecPattern.findFirstMatchIn(lines(i)).foreach { m =>
                val importPath = m.group(2)
                if (!entities.exists(e => e.name == importPath && e.kind == NodeKind.Module)) {
                  entities = entities :+ ParsedEntity(
                    name      = importPath,
                    kind      = NodeKind.Module,
                    attrs     = Map.empty,
                    lineStart = i + 1,
                    lineEnd   = i + 1
                  )
                }
                relationships = relationships :+ ParsedRelationship(fileName, importPath, "IMPORTS")
              }
              i += 1
            }
            handled = true
          }
        }

        // Single import
        if (!handled) {
          ImportSinglePattern.findFirstMatchIn(line).foreach { m =>
            val importPath = m.group(1)
            if (!entities.exists(e => e.name == importPath && e.kind == NodeKind.Module)) {
              entities = entities :+ ParsedEntity(
                name      = importPath,
                kind      = NodeKind.Module,
                attrs     = Map.empty,
                lineStart = lineNum,
                lineEnd   = lineNum
              )
            }
            relationships = relationships :+ ParsedRelationship(fileName, importPath, "IMPORTS")
            handled = true
          }
        }

        // Const (single)
        if (!handled) {
          ConstGroupStart.findFirstMatchIn(line).foreach { _ =>
            i += 1
            while (i < lines.length && !lines(i).trim.startsWith(")")) {
              ConstSpecPattern.findFirstMatchIn(lines(i).trim).foreach { m =>
                val name = m.group(1)
                if (name != "//" && name != "/*" && name != "_") {
                  val exported = name.nonEmpty && name.head.isUpper
                  entities = entities :+ ParsedEntity(
                    name      = name,
                    kind      = NodeKind.Variable,
                    attrs     = Map(
                      "language" -> Json.fromString("go"),
                      "go_kind"  -> Json.fromString("const"),
                      "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                      "exported" -> Json.fromBoolean(exported)
                    ),
                    lineStart = i + 1,
                    lineEnd   = i + 1
                  )
                  relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
                }
              }
              i += 1
            }
            handled = true
          }
        }

        if (!handled) {
          ConstPattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            if (name != "(" && name != "_") {
              val exported = name.nonEmpty && name.head.isUpper
              entities = entities :+ ParsedEntity(
                name      = name,
                kind      = NodeKind.Variable,
                attrs     = Map(
                  "language" -> Json.fromString("go"),
                  "go_kind"  -> Json.fromString("const"),
                  "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                  "exported" -> Json.fromBoolean(exported)
                ),
                lineStart = lineNum,
                lineEnd   = lineNum
              )
              relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
              handled = true
            }
          }
        }

        // Var group
        if (!handled) {
          VarGroupStart.findFirstMatchIn(line).foreach { _ =>
            i += 1
            while (i < lines.length && !lines(i).trim.startsWith(")")) {
              val varLine = lines(i).trim
              if (varLine.nonEmpty && !varLine.startsWith("//") && !varLine.startsWith("/*")) {
                varLine.split("\\s+").headOption.foreach { name =>
                  if (name != "_" && name.matches("\\w+")) {
                    val exported = name.nonEmpty && name.head.isUpper
                    entities = entities :+ ParsedEntity(
                      name      = name,
                      kind      = NodeKind.Variable,
                      attrs     = Map(
                        "language" -> Json.fromString("go"),
                        "go_kind"  -> Json.fromString("var"),
                        "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                        "exported" -> Json.fromBoolean(exported)
                      ),
                      lineStart = i + 1,
                      lineEnd   = i + 1
                    )
                    relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
                  }
                }
              }
              i += 1
            }
            handled = true
          }
        }

        if (!handled) {
          VarPattern.findFirstMatchIn(line).foreach { m =>
            val name = m.group(1)
            if (name != "(" && name != "_") {
              val exported = name.nonEmpty && name.head.isUpper
              entities = entities :+ ParsedEntity(
                name      = name,
                kind      = NodeKind.Variable,
                attrs     = Map(
                  "language" -> Json.fromString("go"),
                  "go_kind"  -> Json.fromString("var"),
                  "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                  "exported" -> Json.fromBoolean(exported)
                ),
                lineStart = lineNum,
                lineEnd   = lineNum
              )
              relationships = relationships :+ ParsedRelationship(fileName, name, "CONTAINS")
              handled = true
            }
          }
        }

        if (!handled) i += 1
        else if (i == lineNum - 1) i += 1 // advance if we didn't already
      }
    }

    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = fileAttrs,
      lineStart = 1,
      lineEnd   = lines.length
    )

    ParseResult(fileEntity +: entities, relationships)
  }

  private def findBraceBlockEnd(lines: Array[String], startIdx: Int): Option[Int] = {
    var braceCount = 0
    var foundOpen = false
    var i = startIdx

    while (i < lines.length) {
      val line = lines(i)
      for (ch <- line) {
        ch match {
          case '{' =>
            braceCount += 1
            foundOpen = true
          case '}' =>
            braceCount -= 1
            if (foundOpen && braceCount == 0) {
              return Some(i + 1)
            }
          case _ =>
        }
      }
      i += 1
    }

    if (foundOpen) Some(lines.length) else None
  }

  private def extractCalls(lines: Array[String], startIdx: Int, endIdx: Int, callerName: String): Vector[ParsedRelationship] = {
    var calls = Vector.empty[ParsedRelationship]
    val seen = scala.collection.mutable.Set.empty[String]
    for (i <- (startIdx + 1) until endIdx.min(lines.length)) {
      val line = lines(i).trim
      if (!line.startsWith("//") && !line.startsWith("/*")) {
        CallPattern.findAllMatchIn(line).foreach { m =>
          val callee = m.group(1)
          if (callee != callerName && !GoBuiltins.contains(callee) &&
              !GoKeywords.contains(callee) && !seen.contains(callee)) {
            seen += callee
            calls = calls :+ ParsedRelationship(callerName, callee, "CALLS")
          }
        }
      }
    }
    calls
  }
}
