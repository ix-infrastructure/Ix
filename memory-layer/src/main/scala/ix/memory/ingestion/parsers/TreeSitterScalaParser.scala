package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json
import org.treesitter.{TSNode, TreeSitterScala}

import scala.util.matching.Regex

/**
 * Tree-sitter AST-based Scala parser with regex fallback.
 * Produces the same ParseResult shape as the original regex ScalaParser.
 */
class TreeSitterScalaParser extends Parser {

  private val regexFallback = new ScalaParser()

  def parse(fileName: String, source: String): ParseResult = {
    try treeSitterParse(fileName, source)
    catch { case _: Throwable => regexFallback.parse(fileName, source) }
  }

  private def treeSitterParse(fileName: String, source: String): ParseResult = {
    TreeSitterUtils.withParse(new TreeSitterScala(), source) { root =>
      val ctx = new ScalaExtractionContext(fileName, source, root)
      ctx.result()
    }
  }

  // -------------------------------------------------------------------------
  // Extraction context — accumulates entities and relationships
  // -------------------------------------------------------------------------

  private class ScalaExtractionContext(
    fileName: String,
    source: String,
    root: TSNode
  ) {
    import TreeSitterUtils._

    var entities      = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    // Initialize with file entity
    entities = entities :+ ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("scala")),
      lineStart = 1,
      lineEnd   = source.split("\n", -1).length
    )

    // Walk the root
    walkChildren(root, enclosing = None)

    def result(): ParseResult = ParseResult(entities, relationships)

    private def walkChildren(node: TSNode, enclosing: Option[String]): Unit = {
      for (child <- namedChildren(node)) {
        walkNode(child, enclosing)
      }
    }

    private def walkNode(node: TSNode, enclosing: Option[String]): Unit = {
      node.getType() match {
        case "object_definition" =>
          handleTypeDefinition(node, enclosing, NodeKind.Object, "object")
        case "class_definition" =>
          val isCaseClass = hasCaseModifier(node)
          val scalaKind = if (isCaseClass) "case_class" else "class"
          handleTypeDefinition(node, enclosing, NodeKind.Class, scalaKind)
        case "trait_definition" =>
          handleTypeDefinition(node, enclosing, NodeKind.Trait, "trait")
        case "function_definition" =>
          handleFunctionDefinition(node, enclosing)
        case "import_declaration" =>
          handleImport(node)
        case "template_body" =>
          walkChildren(node, enclosing)
        case "package_clause" =>
          // recurse into package body
          walkChildren(node, enclosing)
        case _ =>
          // Recurse into other nodes to catch nested definitions
          walkChildren(node, enclosing)
      }
    }

    private def handleTypeDefinition(
      node: TSNode,
      enclosing: Option[String],
      kind: NodeKind,
      scalaKind: String
    ): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { name =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val sig = extractTypeSignature(node)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(sig, bodyText)
        val vis = extractVisibility(node)

        entities = entities :+ ParsedEntity(
          name      = name,
          kind      = kind,
          attrs     = Map(
            "scala_kind" -> Json.fromString(scalaKind),
            "language"   -> Json.fromString("scala"),
            "signature"  -> Json.fromString(sig),
            "visibility" -> Json.fromString(vis)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )

        // CONTAINS edge
        val containsSrc = enclosing.getOrElse(fileName)
        relationships = relationships :+ ParsedRelationship(containsSrc, name, "CONTAINS")

        // EXTENDS edge
        findChild(node, "extends_clause").foreach { extendsNode =>
          // First type in extends clause is the parent
          val types = collectDescendants(extendsNode, n =>
            n.getType() == "type_identifier" || n.getType() == "identifier"
          )
          types.headOption.foreach { typeNode =>
            val parentName = nodeText(typeNode, source)
            if (parentName.nonEmpty && parentName.head.isUpper) {
              relationships = relationships :+ ParsedRelationship(name, parentName, "EXTENDS")
            }
          }
        }

        // Recurse into template_body
        findChild(node, "template_body").orElse(findChild(node, "body")).foreach { body =>
          walkChildren(body, Some(name))
        }
      }
    }

    private def handleFunctionDefinition(node: TSNode, enclosing: Option[String]): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { funcName =>
        val start = lineStart(node)
        val end = lineEnd(node)

        val (kind, containsSrc) = enclosing match {
          case Some(typeName) => (NodeKind.Method, typeName)
          case None           => (NodeKind.Function, fileName)
        }

        val sig = extractFunctionSignature(node)
        val vis = extractVisibility(node)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(sig, bodyText)

        entities = entities :+ ParsedEntity(
          name      = funcName,
          kind      = kind,
          attrs     = Map(
            "language"   -> Json.fromString("scala"),
            "summary"    -> Json.fromString(sig),
            "signature"  -> Json.fromString(sig),
            "visibility" -> Json.fromString(vis)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )

        relationships = relationships :+ ParsedRelationship(containsSrc, funcName, "CONTAINS")

        // Extract CALLS from body
        fieldChild(node, "body").foreach { body =>
          extractCalls(body, funcName, enclosing.getOrElse(""))
        }

        // Extract REFERENCES from signature types
        extractSignatureRefs(node, funcName, enclosing.getOrElse(""))
      }
    }

    private def extractCalls(bodyNode: TSNode, callerName: String, enclosingTypeName: String): Unit = {
      val seen = scala.collection.mutable.Set.empty[String]
      val refSeen = scala.collection.mutable.Set.empty[String]

      val callExprs = collectDescendants(bodyNode, _.getType() == "call_expression")
      for (callExpr <- callExprs) {
        // Scala grammar: call_expression first named child is the function
        val funcNodeOpt = fieldChild(callExpr, "function")
          .orElse(if (callExpr.getNamedChildCount() > 0) Some(callExpr.getNamedChild(0)) else None)

        funcNodeOpt.foreach { funcNode =>
          val callee = resolveScalaCallee(funcNode)
          callee.foreach { name =>
            if (name != callerName && !ScalaBuiltins.contains(name) &&
                !seen.contains(name) && name.nonEmpty && name.head.isLower) {
              seen += name
              relationships = relationships :+ ParsedRelationship(callerName, name, "CALLS")
            }
          }
        }
      }

      // Extract qualified REFERENCES (e.g., NodeKind.File, SourceType.Code)
      // Scala tree-sitter grammar: field_expression has plain identifier children
      // (first child = object, third child = field, with "." in between)
      val fieldExprs = collectDescendants(bodyNode, _.getType() == "field_expression")
      for (fe <- fieldExprs) {
        // Try named field first, then fall back to first named child as qualifier
        val objNode = fieldChild(fe, "object")
          .orElse(fieldChild(fe, "qualifier"))
          .orElse {
            val named = namedChildren(fe)
            named.headOption.filter(_.getType() == "identifier")
          }
        objNode.foreach { on =>
          if (on.getType() == "identifier") {
            val qualifier = nodeText(on, source)
            if (qualifier.nonEmpty && qualifier.head.isUpper &&
                !ScalaBuiltinTypes.contains(qualifier) && !ScalaBuiltins.contains(qualifier) &&
                !refSeen.contains(qualifier) && qualifier != callerName &&
                qualifier != enclosingTypeName) {
              refSeen += qualifier
              relationships = relationships :+ ParsedRelationship(callerName, qualifier, "REFERENCES")
            }
          }
        }
      }
    }

    private def resolveScalaCallee(funcNode: TSNode): Option[String] = {
      funcNode.getType() match {
        case "identifier" =>
          Some(nodeText(funcNode, source))
        case "field_expression" =>
          // Scala field_expression: children are [object, ".", field]
          // Last named child is the field/method name
          val named = namedChildren(funcNode)
          named.lastOption.map(n => nodeText(n, source))
        case "call_expression" =>
          // Chained calls — recurse
          val inner = if (funcNode.getNamedChildCount() > 0) Some(funcNode.getNamedChild(0)) else None
          inner.flatMap(resolveScalaCallee)
        case _ => None
      }
    }

    private def extractSignatureRefs(node: TSNode, funcName: String, enclosingTypeName: String): Unit = {
      // Use regex on the signature text for type references — pragmatic hybrid approach
      val sig = extractFunctionSignature(node)
      val TypeRefPattern: Regex = """\b([A-Z]\w+)""".r
      val refs = TypeRefPattern.findAllMatchIn(sig).map(_.group(1)).toSet
      for (ref <- refs) {
        if (!ScalaBuiltinTypes.contains(ref) && ref != funcName &&
            ref != enclosingTypeName && ref != fileName) {
          relationships = relationships :+ ParsedRelationship(funcName, ref, "REFERENCES")
        }
      }
    }

    private def handleImport(node: TSNode): Unit = {
      val importText = nodeText(node, source)
        .stripPrefix("import ")
        .trim

      val moduleName = if (importText.contains("{")) {
        importText.substring(0, importText.indexOf('{')).stripSuffix(".").trim
      } else {
        importText
      }

      if (moduleName.nonEmpty && !entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
        entities = entities :+ ParsedEntity(
          name      = moduleName,
          kind      = NodeKind.Module,
          attrs     = Map.empty,
          lineStart = lineStart(node),
          lineEnd   = lineEnd(node)
        )
      }
      if (moduleName.nonEmpty) {
        relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
      }
    }

    // --- Helpers ---

    private def hasCaseModifier(node: TSNode): Boolean = {
      // Check for "case" modifier in the node text before the keyword
      val text = nodeText(node, source)
      text.trim.startsWith("case ") || text.contains(" case class") ||
        // Check modifiers children
        allChildren(node).exists { child =>
          child.getType() == "case" ||
            (child.getType() == "modifiers" && nodeText(child, source).contains("case"))
        }
    }

    private def extractTypeSignature(node: TSNode): String = {
      val text = nodeText(node, source)
      val firstLine = text.split("\n").head
      firstLine.replaceAll("""\s*\{\s*$""", "").trim.take(120)
    }

    private def extractFunctionSignature(node: TSNode): String = {
      val text = nodeText(node, source)
      val sig = text.split("\n").head
        .replaceAll("""\s*=\s*\{?\s*$""", "")
        .replaceAll("""\s*\{\s*$""", "")
        .trim
      sig.take(120)
    }

    private def extractVisibility(node: TSNode): String = {
      val text = nodeText(node, source).trim
      val withoutOverride = text.replaceFirst("""^\s*override\s+""", "").trim
      if (withoutOverride.startsWith("private")) "private"
      else if (withoutOverride.startsWith("protected")) "protected"
      else "public"
    }
  }

  // --- Shared constants (reused from ScalaParser) ---

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
}
