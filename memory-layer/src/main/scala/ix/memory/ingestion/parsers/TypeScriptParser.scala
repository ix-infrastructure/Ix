package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * TypeScript/JavaScript source parser that extracts structural entities
 * and relationships using regex-based extraction.
 */
class TypeScriptParser extends Parser {

  /**
   * Parse a TypeScript source file and extract entities and relationships.
   *
   * @param fileName the file name (e.g. "api.ts")
   * @param source   the full source code as a string
   * @return ParseResult with entities and relationships
   */
  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    // -- File entity (no raw content stored) --
    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("typescript")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    var entities = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    // Track class ranges for containment
    var classRanges = Vector.empty[(String, Int, Int)]

    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1
      val trimmed = line.trim

      // Skip comment lines
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        // no-op
      } else {

        // Check for class definition
        ClassPattern.findFirstMatchIn(line).foreach { m =>
          val className = m.group(1)
          val classEnd = findBraceBlockEnd(lines, idx)
          entities = entities :+ ParsedEntity(
            name      = className,
            kind      = NodeKind.Class,
            attrs     = Map("language" -> Json.fromString("typescript")),
            lineStart = lineNum,
            lineEnd   = classEnd
          )
          relationships = relationships :+ ParsedRelationship(fileName, className, "DEFINES")
          classRanges = classRanges :+ (className, lineNum, classEnd)

          // Extract methods from this class
          val methods = extractMethods(lines, idx, classEnd, className)
          entities = entities ++ methods._1
          relationships = relationships ++ methods._2
        }

        // Check for top-level function (not inside a class)
        if (!insideClass(lineNum, classRanges)) {
          FuncPattern.findFirstMatchIn(line).foreach { m =>
            val funcName = m.group(1)
            val funcEnd = findBraceBlockEnd(lines, idx)
            val summary = line.trim.take(120)
            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = NodeKind.Function,
              attrs     = Map(
                "language" -> Json.fromString("typescript"),
                "summary"  -> Json.fromString(summary)
              ),
              lineStart = lineNum,
              lineEnd   = funcEnd
            )
            relationships = relationships :+ ParsedRelationship(fileName, funcName, "DEFINES")

            // Extract calls within this function
            val calls = extractCalls(lines, idx, funcEnd, funcName)
            relationships = relationships ++ calls
          }

          // Check for arrow function / const function
          val arrowMatch = ArrowFuncPattern.findFirstMatchIn(line)
          val constFuncMatch = ConstFuncPattern.findFirstMatchIn(line)
          val funcMatch = arrowMatch.orElse(constFuncMatch)
          funcMatch.foreach { m =>
            val funcName = m.group(1)
            // Avoid duplicates if already captured by FuncPattern
            if (!entities.exists(e => e.name == funcName && e.kind == NodeKind.Function)) {
              val funcEnd = findBraceBlockEnd(lines, idx)
              val summary = line.trim.take(120)
              entities = entities :+ ParsedEntity(
                name      = funcName,
                kind      = NodeKind.Function,
                attrs     = Map(
                  "language" -> Json.fromString("typescript"),
                  "summary"  -> Json.fromString(summary)
                ),
                lineStart = lineNum,
                lineEnd   = funcEnd
              )
              relationships = relationships :+ ParsedRelationship(fileName, funcName, "DEFINES")

              val callRels = extractCalls(lines, idx, funcEnd, funcName)
              relationships = relationships ++ callRels
            }
          }
        }

        // Check for imports
        ImportPattern.findFirstMatchIn(line).foreach { m =>
          val moduleName = m.group(1)
          if (!entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
            entities = entities :+ ParsedEntity(
              name      = moduleName,
              kind      = NodeKind.Module,
              attrs     = Map.empty,
              lineStart = lineNum,
              lineEnd   = lineNum
            )
          }
          relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
        }

        SideEffectImportPattern.findFirstMatchIn(line).foreach { m =>
          val moduleName = m.group(1)
          if (!relationships.exists(r => r.dstName == moduleName && r.predicate == "IMPORTS")) {
            if (!entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
              entities = entities :+ ParsedEntity(
                name      = moduleName,
                kind      = NodeKind.Module,
                attrs     = Map.empty,
                lineStart = lineNum,
                lineEnd   = lineNum
              )
            }
            relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
          }
        }

        // Check for interface definition
        InterfacePattern.findFirstMatchIn(line).foreach { m =>
          val ifaceName = m.group(1)
          if (!entities.exists(e => e.name == ifaceName && e.kind == NodeKind.Class)) {
            val ifaceEnd = findBraceBlockEnd(lines, idx)
            entities = entities :+ ParsedEntity(
              name      = ifaceName,
              kind      = NodeKind.Class, // model interfaces as Class kind
              attrs     = Map(
                "language"  -> Json.fromString("typescript"),
                "ts_kind"   -> Json.fromString("interface")
              ),
              lineStart = lineNum,
              lineEnd   = ifaceEnd
            )
            relationships = relationships :+ ParsedRelationship(fileName, ifaceName, "DEFINES")
          }
        }

        // Check for type alias
        TypeAliasPattern.findFirstMatchIn(line).foreach { m =>
          val typeName = m.group(1)
          if (!trimmed.startsWith("import")) {
            entities = entities :+ ParsedEntity(
              name      = typeName,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language" -> Json.fromString("typescript"),
                "ts_kind"  -> Json.fromString("type_alias")
              ),
              lineStart = lineNum,
              lineEnd   = lineNum
            )
            relationships = relationships :+ ParsedRelationship(fileName, typeName, "DEFINES")
          }
        }

      } // end else (non-comment)
    }

    ParseResult(entities, relationships)
  }

  // ---------------------------------------------------------------------------
  // Patterns
  // ---------------------------------------------------------------------------

  private val ClassPattern: Regex      = """(?:export\s+)?(?:abstract\s+)?class\s+(\w+)""".r
  private val FuncPattern: Regex       = """(?:export\s+)?(?:async\s+)?function\s+(\w+)""".r
  private val ArrowFuncPattern: Regex  = """(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=]+)?\s*=>""".r
  private val ConstFuncPattern: Regex  = """(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function""".r
  private val MethodPattern: Regex     = """^\s+(?:async\s+)?(?:private\s+|public\s+|protected\s+|static\s+|readonly\s+)*(\w+)\s*(?:<[^>]+>)?\s*\(""".r
  private val ImportPattern: Regex     = """import\s+.*?from\s+['"]([^'"]+)['"]""".r
  private val SideEffectImportPattern: Regex = """^import\s+['"]([^'"]+)['"]""".r
  private val InterfacePattern: Regex  = """(?:export\s+)?interface\s+(\w+)""".r
  private val TypeAliasPattern: Regex  = """(?:export\s+)?type\s+(\w+)\s*(?:<[^>]+>)?\s*=""".r
  private val CallPattern: Regex       = """(?:(?:this|self|await)\.)?\b(\w+)\s*\(""".r

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private def insideClass(lineNum: Int, classRanges: Vector[(String, Int, Int)]): Boolean =
    classRanges.exists { case (_, start, end) => lineNum > start && lineNum <= end }

  /**
   * Extract methods from a class body.
   */
  private def extractMethods(
    lines: Array[String],
    classStartIdx: Int,
    classEndLine: Int,
    className: String
  ): (Vector[ParsedEntity], Vector[ParsedRelationship]) = {
    var entities = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    var i = classStartIdx + 1
    while (i < lines.length && (i + 1) <= classEndLine) {
      val line = lines(i)
      val lineNum = i + 1

      if (!line.trim.startsWith("//") && !line.trim.startsWith("*")) {
        MethodPattern.findFirstMatchIn(line).foreach { m =>
          val methodName = m.group(1)
          // Skip keywords that look like methods
          if (!TypeScriptKeywords.contains(methodName)) {
            val methodEnd = findBraceBlockEnd(lines, i)
            val summary = line.trim.take(120)
            entities = entities :+ ParsedEntity(
              name      = methodName,
              kind      = NodeKind.Function,
              attrs     = Map(
                "language" -> Json.fromString("typescript"),
                "summary"  -> Json.fromString(summary)
              ),
              lineStart = lineNum,
              lineEnd   = methodEnd
            )
            relationships = relationships :+ ParsedRelationship(className, methodName, "DEFINES")

            // Extract calls within this method
            val calls = extractCalls(lines, i, methodEnd, methodName)
            relationships = relationships ++ calls
          }
        }
      }
      i += 1
    }

    (entities, relationships)
  }

  /**
   * Find end of a brace-delimited block starting near `startIdx`.
   */
  private def findBraceBlockEnd(lines: Array[String], startIdx: Int): Int = {
    var braceCount = 0
    var foundOpen = false
    var i = startIdx
    while (i < lines.length) {
      for (ch <- lines(i)) {
        if (ch == '{') { braceCount += 1; foundOpen = true }
        if (ch == '}') braceCount -= 1
      }
      if (foundOpen && braceCount <= 0) return i + 1
      i += 1
    }
    lines.length
  }

  /**
   * Extract CALLS relationships from a function/method body.
   */
  private def extractCalls(
    lines: Array[String],
    funcStartIdx: Int,
    funcEndLine: Int,
    callerName: String
  ): Vector[ParsedRelationship] = {
    var calls = Vector.empty[ParsedRelationship]
    val seen = scala.collection.mutable.Set.empty[String]
    var i = funcStartIdx + 1

    while (i < lines.length && (i + 1) <= funcEndLine) {
      val line = lines(i)
      CallPattern.findAllMatchIn(line).foreach { m =>
        val callee = m.group(1)
        if (callee != callerName && !TypeScriptBuiltins.contains(callee) &&
            !TypeScriptKeywords.contains(callee) && !seen.contains(callee)) {
          seen += callee
          calls = calls :+ ParsedRelationship(callerName, callee, "CALLS")
        }
      }
      i += 1
    }
    calls
  }

  private val TypeScriptKeywords: Set[String] = Set(
    "if", "else", "for", "while", "do", "switch", "case", "break",
    "continue", "return", "throw", "try", "catch", "finally",
    "new", "delete", "typeof", "instanceof", "void", "in", "of",
    "class", "extends", "implements", "interface", "enum", "type",
    "const", "let", "var", "function", "async", "await",
    "import", "export", "default", "from", "as",
    "this", "super", "constructor", "static", "private", "public", "protected"
  )

  private val TypeScriptBuiltins: Set[String] = Set(
    "console", "log", "error", "warn", "parseInt", "parseFloat",
    "String", "Number", "Boolean", "Array", "Object", "Promise",
    "JSON", "Math", "Date", "RegExp", "Error", "Map", "Set",
    "WeakMap", "WeakSet", "Symbol",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "require", "module", "exports",
    "fetch", "Response", "Request", "URL", "Buffer", "process"
  )
}
