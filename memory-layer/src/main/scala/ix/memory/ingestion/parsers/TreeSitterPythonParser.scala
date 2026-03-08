package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * Python source parser that extracts structural entities and relationships.
 *
 * Attempts to use tree-sitter JNI first; falls back to regex-based extraction
 * when the native library is unavailable (common on some platforms).
 * The regex fallback is sufficient for Phase 1 since the goal is the pipeline
 * structure, not production-grade parsing.
 */
class TreeSitterPythonParser extends Parser {

  /**
   * Parse a Python source file and extract entities and relationships.
   *
   * @param fileName the file name (e.g. "billing_service.py")
   * @param source   the full source code as a string
   * @return ParseResult with entities and relationships
   */
  def parse(fileName: String, source: String): ParseResult = {
    // Try tree-sitter first, fall back to regex
    tryTreeSitter(fileName, source).getOrElse(regexParse(fileName, source))
  }

  // ---------------------------------------------------------------------------
  // Tree-sitter JNI attempt
  // ---------------------------------------------------------------------------

  private def tryTreeSitter(fileName: String, source: String): Option[ParseResult] = {
    try {
      val langClass = Class.forName("ch.usi.si.seart.treesitter.Language")
      val pythonLang = langClass.getMethod("valueOf", classOf[String]).invoke(null, "PYTHON")

      val parserClass = Class.forName("ch.usi.si.seart.treesitter.Parser")
      val parser = parserClass.getMethod("getFor", langClass).invoke(null, pythonLang)

      val tree = parserClass.getMethod("parse", classOf[String]).invoke(parser, source)
      val treeClass = Class.forName("ch.usi.si.seart.treesitter.Tree")
      val root = treeClass.getMethod("getRootNode").invoke(tree)

      // If we get here, tree-sitter loaded successfully
      // We would walk the AST here, but for now this path is not reached
      // on platforms where the JNI library is unavailable.
      parserClass.getMethod("close").invoke(parser)
      treeClass.getMethod("close").invoke(tree)
      None // TODO: implement full tree-sitter AST walking when JNI works
    } catch {
      case _: Throwable => None // Catches both Exception and Error (e.g. UnsatisfiedLinkError)
    }
  }

  // ---------------------------------------------------------------------------
  // Regex-based fallback parser
  // ---------------------------------------------------------------------------

  private val ClassPattern: Regex   = """^class\s+(\w+)""".r
  private val FuncPattern: Regex    = """^(\s*)def\s+(\w+)""".r
  private val ImportPattern: Regex  = """^import\s+(\w+)""".r
  private val FromImportPattern: Regex = """^from\s+(\w+)\s+import""".r
  private val CallPattern: Regex    = """(?:self\.)?(\w+)\(""".r

  private def regexParse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    // -- File entity --
    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("python")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    // -- Classes and functions --
    var entities = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    // Track class ranges: (className, lineStart, lineEnd) for containment checks
    var classRanges = Vector.empty[(String, Int, Int)]

    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1

      // Skip comment lines — prevents matching patterns inside comments
      if (line.trim.startsWith("#")) {
        // no-op: skip this line entirely
      } else {

      // Check for class definition
      ClassPattern.findFirstMatchIn(line).foreach { m =>
        val className = m.group(1)
        val classEnd = findBlockEnd(lines, idx)
        entities = entities :+ ParsedEntity(
          name      = className,
          kind      = NodeKind.Class,
          attrs     = Map("language" -> Json.fromString("python")),
          lineStart = lineNum,
          lineEnd   = classEnd
        )
        // File CONTAINS class
        relationships = relationships :+ ParsedRelationship(fileName, className, "CONTAINS")
        classRanges = classRanges :+ (className, lineNum, classEnd)
      }

      // Check for function/method definition
      FuncPattern.findFirstMatchIn(line).foreach { m =>
        val funcName = m.group(2)

        entities = entities :+ ParsedEntity(
          name      = funcName,
          kind      = NodeKind.Function,
          attrs     = Map("language" -> Json.fromString("python")),
          lineStart = lineNum,
          lineEnd   = findBlockEnd(lines, idx)
        )

        // Check if this function's line falls within any class range
        val enclosingClass = classRanges.find { case (_, start, end) =>
          lineNum > start && lineNum <= end
        }
        enclosingClass match {
          case Some((className, _, _)) =>
            // Method inside a class
            relationships = relationships :+ ParsedRelationship(className, funcName, "CONTAINS")
          case None =>
            // Top-level function — file defines it
            relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")
        }

        // Extract function calls within the function body
        val callsInFunc = extractCalls(lines, idx, funcName)
        relationships = relationships ++ callsInFunc
      }

      // Check for imports
      ImportPattern.findFirstMatchIn(line).foreach { m =>
        val moduleName = m.group(1)
        entities = entities :+ ParsedEntity(
          name      = moduleName,
          kind      = NodeKind.Module,
          attrs     = Map.empty,
          lineStart = lineNum,
          lineEnd   = lineNum
        )
        relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
      }

      FromImportPattern.findFirstMatchIn(line).foreach { m =>
        val moduleName = m.group(1)
        // Avoid duplicate module entities
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

      } // end else (non-comment line)
    }

    ParseResult(entities, relationships)
  }

  /**
   * Find the end line of a block starting at `startIdx` using indentation.
   * Looks for the last line that has greater indentation than the definition line.
   */
  private def findBlockEnd(lines: Array[String], startIdx: Int): Int = {
    val baseIndent = lines(startIdx).takeWhile(_ == ' ').length
    var endIdx = startIdx
    var i = startIdx + 1
    while (i < lines.length) {
      val line = lines(i)
      if (line.trim.nonEmpty) {
        val indent = line.takeWhile(_ == ' ').length
        if (indent > baseIndent) {
          endIdx = i
        } else {
          // Block ended
          return endIdx + 1
        }
      }
      i += 1
    }
    // If we reach end of file, the block extends to the end
    endIdx + 1
  }

  /**
   * Extract CALLS relationships from the body of a function starting at `funcIdx`.
   * Uses a simple heuristic: look for `identifier(` patterns in subsequent indented lines.
   */
  private def extractCalls(lines: Array[String], funcIdx: Int, callerName: String): Vector[ParsedRelationship] = {
    val baseIndent = lines(funcIdx).takeWhile(_ == ' ').length
    var calls = Vector.empty[ParsedRelationship]
    val seen = scala.collection.mutable.Set.empty[String]
    var i = funcIdx + 1

    while (i < lines.length) {
      val line = lines(i)
      if (line.trim.nonEmpty) {
        val indent = line.takeWhile(_ == ' ').length
        if (indent <= baseIndent) {
          // Exited the function body
          return calls
        }
        // Find calls in this line
        CallPattern.findAllMatchIn(line).foreach { m =>
          val callee = m.group(1)
          // Filter out Python builtins and self-references, and skip 'self' prefix calls
          // that match the method name itself
          if (callee != callerName && !PythonBuiltins.contains(callee) && !seen.contains(callee)) {
            seen += callee
            calls = calls :+ ParsedRelationship(callerName, callee, "CALLS")
          }
        }
      }
      i += 1
    }
    calls
  }

  private val PythonBuiltins: Set[String] = Set(
    "print", "len", "range", "int", "str", "float", "list", "dict",
    "set", "tuple", "type", "isinstance", "issubclass", "hasattr",
    "getattr", "setattr", "delattr", "super", "property", "staticmethod",
    "classmethod", "enumerate", "zip", "map", "filter", "sorted",
    "reversed", "any", "all", "min", "max", "sum", "abs", "round",
    "input", "open", "format", "repr", "id", "hash", "callable",
    "iter", "next", "not", "raise"
  )
}
