package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

/**
 * Regex-based Scala source parser that extracts structural entities and relationships.
 *
 * Extracts: traits, classes, case classes, objects, methods (def), and imports.
 * Uses brace counting for block boundary detection.
 */
class ScalaParser extends Parser {

  // Patterns for Scala constructs
  private val TraitPattern: Regex      = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*trait\s+(\w+)""".r
  private val ClassPattern: Regex      = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*class\s+(\w+)""".r
  private val CaseClassPattern: Regex  = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*case\s+class\s+(\w+)""".r
  private val ObjectPattern: Regex     = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*(?:case\s+)?object\s+(\w+)""".r
  private val DefPattern: Regex        = """^\s*(?:override\s+)?(?:private(?:\[\w+\])?\s+|protected(?:\[\w+\])?\s+)?(?:final\s+)?def\s+(\w+)""".r
  private val ImportPattern: Regex     = """^\s*import\s+(.+)$""".r
  private val CallPattern: Regex      = """(?:(?:this|super)\.)?\b(\w+)\s*(?:\[.*?\])?\s*\(""".r
  private val ExtendsPattern: Regex      = """extends\s+(\w+)""".r
  private val TypeRefPattern: Regex      = """\b([A-Z]\w+)""".r
  private val QualifiedRefPattern: Regex = """\b([A-Z]\w+)\.(\w+)""".r

  private val ScalaBuiltinTypes: Set[String] = Set(
    "String", "Int", "Long", "Double", "Float", "Boolean", "Unit", "Any", "AnyRef", "AnyVal",
    "Nothing", "Null", "Option", "List", "Map", "Set", "Vector", "Seq", "Array", "Future",
    "IO", "Either", "Try", "Some", "None", "Right", "Left", "Success", "Failure"
  )

  private val ScalaBuiltins: Set[String] = Set(
    "println", "print", "require", "assert", "assume",
    "Some", "None", "Option", "List", "Map", "Set", "Vector",
    "Right", "Left", "Try", "Success", "Failure",
    "Future", "IO", "pure", "flatMap", "map", "filter",
    "foreach", "fold", "foldLeft", "foldRight",
    "toString", "hashCode", "equals", "getClass",
    "apply", "unapply", "copy", "andThen", "compose",
    "getOrElse", "orElse", "contains", "exists", "forall",
    "collect", "traverse", "sequence", "attempt", "handleErrorWith",
    "raiseError", "blocking", "delay", "suspend", "async",
    "mkString", "toList", "toVector", "toSet", "toMap",
    "head", "tail", "size", "length", "isEmpty", "nonEmpty",
    "take", "drop", "slice", "zip", "zipWithIndex",
    "sortBy", "groupBy", "distinct", "flatten"
  )

  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("scala")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    var entities      = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    // Track type ranges for containment: (name, startLine, endLine)
    var typeRanges = Vector.empty[(String, Int, Int)]

    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1
      val trimmed = line.trim

      // Skip comment lines
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        // no-op
      } else {

        // Case class must be checked before class (since "case class" contains "class")
        val handledAsType = CaseClassPattern.findFirstMatchIn(line) match {
          case Some(m) =>
            val name = m.group(1)
            val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
            val bodyText = lines.slice(idx, endLine).mkString("\n")
            val fp = Fingerprint.compute(extractTypeSignature(trimmed), bodyText)
            entities = entities :+ ParsedEntity(
              name      = name,
              kind      = NodeKind.Class,
              attrs     = Map("scala_kind" -> Json.fromString("case_class"), "language" -> Json.fromString("scala"),
                "signature" -> Json.fromString(extractTypeSignature(trimmed)), "visibility" -> Json.fromString(extractVisibility(trimmed))),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )
            val enclosingType = typeRanges.find { case (_, start, end) => lineNum > start && lineNum <= end }
            val containsSrc = enclosingType.map(_._1).getOrElse(fileName)
            relationships = relationships :+ ParsedRelationship(containsSrc, name, "CONTAINS")
            typeRanges = typeRanges :+ (name, lineNum, endLine)
            ExtendsPattern.findFirstMatchIn(line).foreach { em =>
              relationships = relationships :+ ParsedRelationship(name, em.group(1), "EXTENDS")
            }
            true

          case None =>
            // Check for trait
            TraitPattern.findFirstMatchIn(line) match {
              case Some(m) =>
                val name = m.group(1)
                val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                val bodyText = lines.slice(idx, endLine).mkString("\n")
                val fp = Fingerprint.compute(extractTypeSignature(trimmed), bodyText)
                entities = entities :+ ParsedEntity(
                  name      = name,
                  kind      = NodeKind.Trait,
                  attrs     = Map("scala_kind" -> Json.fromString("trait"), "language" -> Json.fromString("scala"),
                    "signature" -> Json.fromString(extractTypeSignature(trimmed)), "visibility" -> Json.fromString(extractVisibility(trimmed))),
                  lineStart = lineNum,
                  lineEnd   = endLine,
                  contentFingerprint = Some(fp)
                )
                val enclosingType = typeRanges.find { case (_, start, end) => lineNum > start && lineNum <= end }
                val containsSrc = enclosingType.map(_._1).getOrElse(fileName)
                relationships = relationships :+ ParsedRelationship(containsSrc, name, "CONTAINS")
                typeRanges = typeRanges :+ (name, lineNum, endLine)
                ExtendsPattern.findFirstMatchIn(line).foreach { em =>
                  relationships = relationships :+ ParsedRelationship(name, em.group(1), "EXTENDS")
                }
                true

              case None =>
                // Check for object (before class, since object keyword won't match class pattern)
                ObjectPattern.findFirstMatchIn(line) match {
                  case Some(m) =>
                    val name = m.group(1)
                    val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                    val bodyText = lines.slice(idx, endLine).mkString("\n")
                    val fp = Fingerprint.compute(extractTypeSignature(trimmed), bodyText)
                    entities = entities :+ ParsedEntity(
                      name      = name,
                      kind      = NodeKind.Object,
                      attrs     = Map("scala_kind" -> Json.fromString("object"), "language" -> Json.fromString("scala"),
                        "signature" -> Json.fromString(extractTypeSignature(trimmed)), "visibility" -> Json.fromString(extractVisibility(trimmed))),
                      lineStart = lineNum,
                      lineEnd   = endLine,
                      contentFingerprint = Some(fp)
                    )
                    val enclosingType = typeRanges.find { case (_, start, end) => lineNum > start && lineNum <= end }
                    val containsSrc = enclosingType.map(_._1).getOrElse(fileName)
                    relationships = relationships :+ ParsedRelationship(containsSrc, name, "CONTAINS")
                    typeRanges = typeRanges :+ (name, lineNum, endLine)
                    ExtendsPattern.findFirstMatchIn(line).foreach { em =>
                      relationships = relationships :+ ParsedRelationship(name, em.group(1), "EXTENDS")
                    }
                    true

                  case None =>
                    // Check for class
                    ClassPattern.findFirstMatchIn(line) match {
                      case Some(m) =>
                        val name = m.group(1)
                        val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                        val bodyText = lines.slice(idx, endLine).mkString("\n")
                        val fp = Fingerprint.compute(extractTypeSignature(trimmed), bodyText)
                        entities = entities :+ ParsedEntity(
                          name      = name,
                          kind      = NodeKind.Class,
                          attrs     = Map("scala_kind" -> Json.fromString("class"), "language" -> Json.fromString("scala"),
                            "signature" -> Json.fromString(extractTypeSignature(trimmed)), "visibility" -> Json.fromString(extractVisibility(trimmed))),
                          lineStart = lineNum,
                          lineEnd   = endLine,
                          contentFingerprint = Some(fp)
                        )
                        val enclosingType = typeRanges.find { case (_, start, end) => lineNum > start && lineNum <= end }
                        val containsSrc = enclosingType.map(_._1).getOrElse(fileName)
                        relationships = relationships :+ ParsedRelationship(containsSrc, name, "CONTAINS")
                        typeRanges = typeRanges :+ (name, lineNum, endLine)
                        ExtendsPattern.findFirstMatchIn(line).foreach { em =>
                          relationships = relationships :+ ParsedRelationship(name, em.group(1), "EXTENDS")
                        }
                        true
                      case None => false
                    }
                }
            }
        }

        // Check for def (only if we didn't match a type on this line)
        if (!handledAsType) {
          DefPattern.findFirstMatchIn(line).foreach { m =>
            val funcName = m.group(1)
            val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)

            val signature = extractSignature(trimmed)
            val visibility = extractVisibility(trimmed)

            // Determine enclosing type
            val enclosing = typeRanges.find { case (_, start, end) =>
              lineNum > start && lineNum <= end
            }

            val (kind, edgePredicate, edgeSrc) = enclosing match {
              case Some((typeName, _, _)) => (NodeKind.Method, "CONTAINS", typeName)
              case None                   => (NodeKind.Function, "CONTAINS", fileName)
            }

            val bodyText = lines.slice(idx, endLine).mkString("\n")
            val fp = Fingerprint.compute(signature, bodyText)

            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = kind,
              attrs     = Map(
                "language"   -> Json.fromString("scala"),
                "summary"    -> Json.fromString(signature),
                "signature"  -> Json.fromString(signature),
                "visibility" -> Json.fromString(visibility)
              ),
              lineStart = lineNum,
              lineEnd   = endLine,
              contentFingerprint = Some(fp)
            )

            relationships = relationships :+ ParsedRelationship(edgeSrc, funcName, edgePredicate)

            // Extract CALLS and REFERENCES from method/function body
            val callsInFunc = extractCalls(lines, idx, endLine, funcName)
            relationships = relationships ++ callsInFunc

            // Extract REFERENCES from method signature type annotations
            val enclosingTypeName = enclosing.map(_._1).getOrElse("")
            val sigRefs = TypeRefPattern.findAllMatchIn(signature).map(_.group(1)).toSet
            for (ref <- sigRefs) {
              if (!ScalaBuiltinTypes.contains(ref) && ref != funcName && ref != enclosingTypeName && ref != fileName) {
                relationships = relationships :+ ParsedRelationship(funcName, ref, "REFERENCES")
              }
            }
          }
        }

        // Check for imports
        ImportPattern.findFirstMatchIn(line).foreach { m =>
          val importPath = m.group(1).trim
          // Parse import path: "ix.memory.model.{Claim, GraphNode}" -> module "ix.memory.model"
          // "cats.effect.IO" -> module "cats.effect.IO"
          val moduleName = if (importPath.contains("{")) {
            // Grouped import: take the prefix before the braces
            importPath.substring(0, importPath.indexOf('{')).stripSuffix(".").trim
          } else {
            importPath
          }

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

      } // end else (non-comment)
    }

    ParseResult(entities, relationships)
  }

  /**
   * Find the end of a brace-delimited block starting at `startIdx`.
   * Counts opening and closing braces. Returns None if no opening brace is found
   * (e.g. abstract method in a trait with no body).
   */
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
              return Some(i + 1) // 1-indexed
            }
          case _ => // skip
        }
      }
      // If we found an opening brace and closed it, we'd have returned above
      // If line ends and no brace found yet, keep going
      i += 1
    }

    if (foundOpen) Some(lines.length) else None
  }

  /** Extract CALLS and qualified REFERENCES relationships from a method/function body. */
  private def extractCalls(lines: Array[String], startIdx: Int, endIdx: Int, callerName: String): Vector[ParsedRelationship] = {
    var calls = Vector.empty[ParsedRelationship]
    val seen = scala.collection.mutable.Set.empty[String]
    val refSeen = scala.collection.mutable.Set.empty[String]
    for (i <- (startIdx + 1) until endIdx.min(lines.length)) {
      val line = lines(i).trim
      if (!line.startsWith("//") && !line.startsWith("*")) {
        CallPattern.findAllMatchIn(line).foreach { m =>
          val callee = m.group(1)
          // Only include lowercase-starting identifiers (methods/functions, not types)
          if (callee != callerName && !ScalaBuiltins.contains(callee) && !seen.contains(callee) && callee.head.isLower) {
            seen += callee
            calls = calls :+ ParsedRelationship(callerName, callee, "CALLS")
          }
        }
        // Extract qualified REFERENCES (e.g., NodeKind.File, SourceType.Code)
        QualifiedRefPattern.findAllMatchIn(line).foreach { m =>
          val qualifier = m.group(1)
          if (!ScalaBuiltinTypes.contains(qualifier) && !ScalaBuiltins.contains(qualifier) &&
              !refSeen.contains(qualifier) && qualifier != callerName) {
            refSeen += qualifier
            calls = calls :+ ParsedRelationship(callerName, qualifier, "REFERENCES")
          }
        }
      }
    }
    calls
  }

  /** Extract a type signature (trait/class/object), stripping body braces. */
  private def extractTypeSignature(trimmedLine: String): String = {
    val cleaned = trimmedLine
      .replaceAll("""\s*\{\s*$""", "")
      .trim
    cleaned.take(120)
  }

  /** Extract a clean signature from a trimmed line, stripping trailing body markers. */
  private def extractSignature(trimmedLine: String): String = {
    val cleaned = trimmedLine
      .replaceAll("""\s*=\s*\{?\s*$""", "")
      .replaceAll("""\s*\{\s*$""", "")
      .trim
    cleaned.take(120)
  }

  /** Detect visibility from a trimmed line (after stripping `override`). */
  private def extractVisibility(trimmedLine: String): String = {
    val withoutOverride = trimmedLine.replaceFirst("""^\s*override\s+""", "").trim
    if (withoutOverride.startsWith("private"))        "private"
    else if (withoutOverride.startsWith("protected")) "protected"
    else                                               "public"
  }
}
