package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
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
          val bodyText = lines.slice(idx, classEnd).mkString("\n")
          val fp = Fingerprint.compute(trimmed.replaceAll("""\s*\{\s*$""", "").take(120), bodyText)
          val exported = trimmed.startsWith("export ") || trimmed.startsWith("export{")
          entities = entities :+ ParsedEntity(
            name      = className,
            kind      = NodeKind.Class,
            attrs     = Map("language" -> Json.fromString("typescript"), "exported" -> Json.fromBoolean(exported)),
            lineStart = lineNum,
            lineEnd   = classEnd,
            contentFingerprint = Some(fp)
          )
          relationships = relationships :+ ParsedRelationship(fileName, className, "CONTAINS")
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
            val bodyText = lines.slice(idx, funcEnd).mkString("\n")
            val fp = Fingerprint.compute(summary, bodyText)
            val exported = trimmed.startsWith("export ") || trimmed.startsWith("export{")
            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = NodeKind.Function,
              attrs     = Map(
                "language"   -> Json.fromString("typescript"),
                "summary"    -> Json.fromString(summary),
                "signature"  -> Json.fromString(summary),
                "visibility" -> Json.fromString("public"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = funcEnd,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")

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
              val bodyText = lines.slice(idx, funcEnd).mkString("\n")
              val fp = Fingerprint.compute(summary, bodyText)
              val exported = trimmed.startsWith("export ") || trimmed.startsWith("export{")
              entities = entities :+ ParsedEntity(
                name      = funcName,
                kind      = NodeKind.Function,
                attrs     = Map(
                  "language"   -> Json.fromString("typescript"),
                  "summary"    -> Json.fromString(summary),
                  "signature"  -> Json.fromString(summary),
                  "visibility" -> Json.fromString("public"),
                  "exported"   -> Json.fromBoolean(exported)
                ),
                lineStart = lineNum,
                lineEnd   = funcEnd,
                contentFingerprint = Some(fp)
              )
              relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")

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

        // Extract named import bindings: import { foo, bar } from "mod"
        NamedImportPattern.findFirstMatchIn(line).foreach { m =>
          val names = m.group(1).split(",").map(_.trim).filter(_.nonEmpty)
          for (rawName <- names) {
            val symbolName = if (rawName.contains(" as ")) rawName.split("\\s+as\\s+").last.trim else rawName
            if (symbolName.nonEmpty && !relationships.exists(r => r.srcName == fileName && r.dstName == symbolName && r.predicate == "IMPORTS")) {
              relationships = relationships :+ ParsedRelationship(fileName, symbolName, "IMPORTS")
            }
          }
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
          if (!entities.exists(e => e.name == ifaceName && e.kind == NodeKind.Interface)) {
            val ifaceEnd = findBraceBlockEnd(lines, idx)
            val bodyText = lines.slice(idx, ifaceEnd).mkString("\n")
            val fp = Fingerprint.compute(trimmed.replaceAll("""\s*\{\s*$""", "").take(120), bodyText)
            val exported = trimmed.startsWith("export ") || trimmed.startsWith("export{")
            entities = entities :+ ParsedEntity(
              name      = ifaceName,
              kind      = NodeKind.Interface,
              attrs     = Map(
                "language"  -> Json.fromString("typescript"),
                "ts_kind"   -> Json.fromString("interface"),
                "exported"  -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = ifaceEnd,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, ifaceName, "CONTAINS")
          }
        }

        // Check for type alias
        TypeAliasPattern.findFirstMatchIn(line).foreach { m =>
          val typeName = m.group(1)
          if (!trimmed.startsWith("import")) {
            val exported = trimmed.startsWith("export ") || trimmed.startsWith("export{")
            val fp = Fingerprint.compute(trimmed.take(120), trimmed)
            entities = entities :+ ParsedEntity(
              name      = typeName,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language" -> Json.fromString("typescript"),
                "ts_kind"  -> Json.fromString("type_alias"),
                "exported" -> Json.fromBoolean(exported)
              ),
              lineStart = lineNum,
              lineEnd   = lineNum,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, typeName, "CONTAINS")
          }
        }

      } // end else (non-comment)
    }

    // Extract file-level calls from code outside named functions/methods/classes
    val coveredRanges: Vector[(Int, Int)] = entities
      .filter(e => e.kind == NodeKind.Function || e.kind == NodeKind.Method || e.kind == NodeKind.Class)
      .map(e => (e.lineStart, e.lineEnd))

    val fileCallsSeen = scala.collection.mutable.Set.empty[String]
    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1
      val inNamedBody = coveredRanges.exists { case (s, e) => lineNum >= s && lineNum <= e }
      if (!inNamedBody && !line.trim.startsWith("//") && !line.trim.startsWith("*")) {
        CallPattern.findAllMatchIn(line).foreach { m =>
          val callee = m.group(1)
          if (!TypeScriptBuiltins.contains(callee) && !TypeScriptKeywords.contains(callee)
              && !fileCallsSeen.contains(callee) && callee != fileName) {
            fileCallsSeen += callee
            relationships = relationships :+ ParsedRelationship(fileName, callee, "CALLS")
          }
        }
      }
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
  private val NamedImportPattern: Regex = """import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]""".r
  private val SideEffectImportPattern: Regex = """^import\s+['"]([^'"]+)['"]""".r
  private val InterfacePattern: Regex  = """(?:export\s+)?interface\s+(\w+)""".r
  private val TypeAliasPattern: Regex  = """(?:export\s+)?type\s+(\w+)\s*(?:<[^>]+>)?\s*=""".r
  private val CallPattern: Regex       = """(?:(?:this|self|await)\.)?\b(\w+)\s*\(""".r

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private def insideClass(lineNum: Int, classRanges: Vector[(String, Int, Int)]): Boolean =
    classRanges.exists { case (_, start, end) => lineNum > start && lineNum <= end }

  private def extractVisibility(trimmedLine: String): String = {
    if (trimmedLine.startsWith("private ") || trimmedLine.startsWith("private\t"))   "private"
    else if (trimmedLine.startsWith("protected ") || trimmedLine.startsWith("protected\t")) "protected"
    else "public"
  }

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
            val visibility = extractVisibility(line.trim)
            val bodyText = lines.slice(i, methodEnd).mkString("\n")
            val fp = Fingerprint.compute(summary, bodyText)
            entities = entities :+ ParsedEntity(
              name      = methodName,
              kind      = NodeKind.Method,
              attrs     = Map(
                "language"   -> Json.fromString("typescript"),
                "summary"    -> Json.fromString(summary),
                "signature"  -> Json.fromString(summary),
                "visibility" -> Json.fromString(visibility)
              ),
              lineStart = lineNum,
              lineEnd   = methodEnd,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(className, methodName, "CONTAINS")

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
   *
   * Uses end-of-line brace depth to detect block entry. This correctly
   * skips inline TypeScript type annotations like `{ kind?: string }`
   * that balance to zero on a single line, which would otherwise cause
   * the parser to think the function body ended on the parameter line.
   */
  private def findBraceBlockEnd(lines: Array[String], startIdx: Int): Int = {
    var braceCount = 0
    var entered = false
    var i = startIdx
    while (i < lines.length) {
      for (ch <- lines(i)) {
        if (ch == '{') braceCount += 1
        if (ch == '}') braceCount -= 1
      }
      // Only mark as entered when braceCount > 0 at end of line.
      // This skips inline type annotations like { a: string; b: number }
      // that balance to 0 within the same line.
      if (!entered && braceCount > 0) entered = true
      if (entered && braceCount <= 0) return i + 1
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
    "fetch", "Response", "Request", "URL", "Buffer", "process",
    // Array/iterable methods
    "map", "filter", "reduce", "forEach", "sort", "find", "some", "every",
    "includes", "indexOf", "slice", "splice", "push", "pop", "shift", "unshift",
    "concat", "join", "flat", "flatMap", "fill", "from",
    // String methods
    "split", "replace", "trim", "toUpperCase", "toLowerCase", "substring",
    "charAt", "startsWith", "endsWith", "padStart", "padEnd", "match", "test",
    // Object methods
    "keys", "values", "entries", "assign", "create", "freeze",
    "defineProperty", "getOwnPropertyNames", "hasOwnProperty",
    // Promise methods
    "then", "catch", "finally", "all", "race", "resolve", "reject"
  )
}
