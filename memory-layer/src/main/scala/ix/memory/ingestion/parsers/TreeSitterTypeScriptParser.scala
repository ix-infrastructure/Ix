package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json
import org.treesitter.{TSNode, TreeSitterTypescript}

/**
 * Tree-sitter AST-based TypeScript parser with regex fallback.
 * Produces the same ParseResult shape as the original regex TypeScriptParser.
 */
class TreeSitterTypeScriptParser extends Parser {

  private val regexFallback = new TypeScriptParser()

  def parse(fileName: String, source: String): ParseResult = {
    try treeSitterParse(fileName, source)
    catch { case _: Throwable => regexFallback.parse(fileName, source) }
  }

  private def treeSitterParse(fileName: String, source: String): ParseResult = {
    TreeSitterUtils.withParse(new TreeSitterTypescript(), source) { root =>
      val ctx = new TSExtractionContext(fileName, source, root)
      ctx.result()
    }
  }

  // -------------------------------------------------------------------------
  // Extraction context
  // -------------------------------------------------------------------------

  private class TSExtractionContext(
    fileName: String,
    source: String,
    root: TSNode
  ) {
    import TreeSitterUtils._

    var entities      = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    private val lines = source.split("\n", -1)

    // Initialize with file entity
    entities = entities :+ ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("typescript")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    // Walk the program
    walkProgram(root)

    def result(): ParseResult = ParseResult(entities, relationships)

    private def walkProgram(node: TSNode): Unit = {
      for (child <- namedChildren(node)) {
        walkTopLevel(child, exported = false)
      }
    }

    private def walkTopLevel(node: TSNode, exported: Boolean): Unit = {
      node.getType() match {
        case "export_statement" =>
          // The actual declaration is a child
          for (child <- namedChildren(node)) {
            walkTopLevel(child, exported = true)
          }

        case "class_declaration" | "abstract_class_declaration" =>
          handleClassDeclaration(node, exported)

        case "function_declaration" =>
          handleFunctionDeclaration(node, exported)

        case "lexical_declaration" | "variable_declaration" =>
          handleVariableDeclaration(node, exported)

        case "interface_declaration" =>
          handleInterfaceDeclaration(node, exported)

        case "type_alias_declaration" =>
          handleTypeAliasDeclaration(node, exported)

        case "import_statement" =>
          handleImport(node)

        case "expression_statement" =>
          // File-level code — extract CALLS
          extractFileLevelCalls(node)

        case "enum_declaration" =>
          handleEnumDeclaration(node, exported)

        case _ =>
          // Ignore other top-level nodes
      }
    }

    // --- Class handling ---

    private def handleClassDeclaration(node: TSNode, exported: Boolean): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { className =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val sig = extractFirstLine(node).replaceAll("""\s*\{\s*$""", "").trim.take(120)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(sig, bodyText)

        entities = entities :+ ParsedEntity(
          name      = className,
          kind      = NodeKind.Class,
          attrs     = Map(
            "language" -> Json.fromString("typescript"),
            "exported" -> Json.fromBoolean(exported)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )
        relationships = relationships :+ ParsedRelationship(fileName, className, "CONTAINS")

        // Extract methods from class body
        findChild(node, "class_body").foreach { body =>
          extractMethods(body, className)
        }
      }
    }

    private def extractMethods(classBody: TSNode, className: String): Unit = {
      for (child <- namedChildren(classBody)) {
        child.getType() match {
          case "method_definition" =>
            handleMethodDefinition(child, className)
          case "public_field_definition" | "property_definition" =>
            // Skip property definitions
          case _ =>
            // Skip other class body members
        }
      }
    }

    private def handleMethodDefinition(node: TSNode, className: String): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { methodName =>
        // Skip constructor
        if (methodName != "constructor" && !TypeScriptKeywords.contains(methodName)) {
          val start = lineStart(node)
          val end = lineEnd(node)
          val summary = extractFirstLine(node).trim.take(120)
          val vis = extractVisibility(node)
          val bodyText = nodeText(node, source)
          val fp = Fingerprint.compute(summary, bodyText)

          entities = entities :+ ParsedEntity(
            name      = methodName,
            kind      = NodeKind.Method,
            attrs     = Map(
              "language"   -> Json.fromString("typescript"),
              "summary"    -> Json.fromString(summary),
              "signature"  -> Json.fromString(summary),
              "visibility" -> Json.fromString(vis)
            ),
            lineStart = start,
            lineEnd   = end,
            contentFingerprint = Some(fp)
          )
          relationships = relationships :+ ParsedRelationship(className, methodName, "CONTAINS")

          // Extract calls from method body
          fieldChild(node, "body").foreach { body =>
            extractCallsFromBody(body, methodName)
          }
        }
      }
    }

    // --- Function handling ---

    private def handleFunctionDeclaration(node: TSNode, exported: Boolean): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { funcName =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val summary = extractFirstLine(node).trim.take(120)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(summary, bodyText)

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
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )
        relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")

        // Extract calls from function body
        fieldChild(node, "body").foreach { body =>
          extractCallsFromBody(body, funcName)
        }
      }
    }

    // --- Variable/arrow function handling ---

    private def handleVariableDeclaration(node: TSNode, exported: Boolean): Unit = {
      for (declarator <- childrenOfType(node, "variable_declarator")) {
        val nameOpt = extractName(declarator, source)
        nameOpt.foreach { varName =>
          // Check if the value is an arrow function or function expression
          fieldChild(declarator, "value").foreach { value =>
            val isFunc = value.getType() == "arrow_function" ||
              value.getType() == "function" ||
              value.getType() == "function_expression"
            if (isFunc && !entities.exists(e => e.name == varName && e.kind == NodeKind.Function)) {
              val start = lineStart(node)
              val end = lineEnd(node)
              val summary = extractFirstLine(node).trim.take(120)
              val bodyText = nodeText(node, source)
              val fp = Fingerprint.compute(summary, bodyText)

              entities = entities :+ ParsedEntity(
                name      = varName,
                kind      = NodeKind.Function,
                attrs     = Map(
                  "language"   -> Json.fromString("typescript"),
                  "summary"    -> Json.fromString(summary),
                  "signature"  -> Json.fromString(summary),
                  "visibility" -> Json.fromString("public"),
                  "exported"   -> Json.fromBoolean(exported)
                ),
                lineStart = start,
                lineEnd   = end,
                contentFingerprint = Some(fp)
              )
              relationships = relationships :+ ParsedRelationship(fileName, varName, "CONTAINS")

              // Extract calls from function body
              fieldChild(value, "body").foreach { body =>
                extractCallsFromBody(body, varName)
              }
            }
          }
        }
      }
    }

    // --- Interface handling ---

    private def handleInterfaceDeclaration(node: TSNode, exported: Boolean): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { ifaceName =>
        if (!entities.exists(e => e.name == ifaceName && e.kind == NodeKind.Interface)) {
          val start = lineStart(node)
          val end = lineEnd(node)
          val sig = extractFirstLine(node).replaceAll("""\s*\{\s*$""", "").trim.take(120)
          val bodyText = nodeText(node, source)
          val fp = Fingerprint.compute(sig, bodyText)

          entities = entities :+ ParsedEntity(
            name      = ifaceName,
            kind      = NodeKind.Interface,
            attrs     = Map(
              "language"  -> Json.fromString("typescript"),
              "ts_kind"   -> Json.fromString("interface"),
              "exported"  -> Json.fromBoolean(exported)
            ),
            lineStart = start,
            lineEnd   = end,
            contentFingerprint = Some(fp)
          )
          relationships = relationships :+ ParsedRelationship(fileName, ifaceName, "CONTAINS")
        }
      }
    }

    // --- Type alias handling ---

    private def handleTypeAliasDeclaration(node: TSNode, exported: Boolean): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { typeName =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val text = nodeText(node, source).trim
        val fp = Fingerprint.compute(text.take(120), text)

        entities = entities :+ ParsedEntity(
          name      = typeName,
          kind      = NodeKind.Class,
          attrs     = Map(
            "language" -> Json.fromString("typescript"),
            "ts_kind"  -> Json.fromString("type_alias"),
            "exported" -> Json.fromBoolean(exported)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )
        relationships = relationships :+ ParsedRelationship(fileName, typeName, "CONTAINS")
      }
    }

    // --- Enum handling ---

    private def handleEnumDeclaration(node: TSNode, exported: Boolean): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { enumName =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(extractFirstLine(node).trim.take(120), bodyText)

        entities = entities :+ ParsedEntity(
          name      = enumName,
          kind      = NodeKind.Class,
          attrs     = Map(
            "language" -> Json.fromString("typescript"),
            "ts_kind"  -> Json.fromString("enum"),
            "exported" -> Json.fromBoolean(exported)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )
        relationships = relationships :+ ParsedRelationship(fileName, enumName, "CONTAINS")
      }
    }

    // --- Import handling ---

    private def handleImport(node: TSNode): Unit = {
      // Extract module path from the source/string child
      val moduleOpt = findChild(node, "string").map(n => nodeText(n, source))
        .map(_.stripPrefix("\"").stripSuffix("\"").stripPrefix("'").stripSuffix("'"))

      moduleOpt.foreach { moduleName =>
        if (!entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
          entities = entities :+ ParsedEntity(
            name      = moduleName,
            kind      = NodeKind.Module,
            attrs     = Map.empty,
            lineStart = lineStart(node),
            lineEnd   = lineEnd(node)
          )
        }
        relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")

        // Extract named imports
        findChild(node, "import_clause").foreach { clause =>
          // Default import: import Foo from "mod"
          findChild(clause, "identifier").foreach { id =>
            val name = nodeText(id, source)
            if (name.nonEmpty && !relationships.exists(r =>
              r.srcName == fileName && r.dstName == name && r.predicate == "IMPORTS")) {
              relationships = relationships :+ ParsedRelationship(fileName, name, "IMPORTS")
            }
          }

          // Named imports: import { a, b as c } from "mod"
          findChild(clause, "named_imports").foreach { namedImports =>
            for (spec <- childrenOfType(namedImports, "import_specifier")) {
              // Use alias if present, otherwise use name
              val alias = fieldChild(spec, "alias").map(n => nodeText(n, source))
              val importName = alias.orElse(extractName(spec, source))
              importName.foreach { name =>
                if (!relationships.exists(r =>
                  r.srcName == fileName && r.dstName == name && r.predicate == "IMPORTS")) {
                  relationships = relationships :+ ParsedRelationship(fileName, name, "IMPORTS")
                }
              }
            }
          }

          // Namespace import: import * as foo from "mod"
          findChild(clause, "namespace_import").foreach { nsImport =>
            findChild(nsImport, "identifier").foreach { id =>
              val name = nodeText(id, source)
              if (name.nonEmpty && !relationships.exists(r =>
                r.srcName == fileName && r.dstName == name && r.predicate == "IMPORTS")) {
                relationships = relationships :+ ParsedRelationship(fileName, name, "IMPORTS")
              }
            }
          }
        }
      }

      // Handle side-effect imports (no import clause, just `import "mod"`)
      if (findChild(node, "import_clause").isEmpty) {
        findChild(node, "string").foreach { strNode =>
          val moduleName = nodeText(strNode, source)
            .stripPrefix("\"").stripSuffix("\"")
            .stripPrefix("'").stripSuffix("'")
          if (moduleName.nonEmpty) {
            if (!entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
              entities = entities :+ ParsedEntity(
                name      = moduleName,
                kind      = NodeKind.Module,
                attrs     = Map.empty,
                lineStart = lineStart(node),
                lineEnd   = lineEnd(node)
              )
            }
            if (!relationships.exists(r => r.dstName == moduleName && r.predicate == "IMPORTS")) {
              relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
            }
          }
        }
      }
    }

    // --- CALLS extraction ---

    private def extractCallsFromBody(bodyNode: TSNode, callerName: String): Unit = {
      val seen = scala.collection.mutable.Set.empty[String]
      val callExprs = collectDescendants(bodyNode, _.getType() == "call_expression")

      for (callExpr <- callExprs) {
        fieldChild(callExpr, "function").foreach { funcNode =>
          val callee = resolveCalleeName(funcNode)
          callee.foreach { name =>
            if (name != callerName && !TypeScriptBuiltins.contains(name) &&
                !TypeScriptKeywords.contains(name) && !seen.contains(name) && name != fileName) {
              seen += name
              relationships = relationships :+ ParsedRelationship(callerName, name, "CALLS")
            }
          }
        }
      }
    }

    private def extractFileLevelCalls(exprStatement: TSNode): Unit = {
      val callExprs = collectDescendants(exprStatement, _.getType() == "call_expression")
      for (callExpr <- callExprs) {
        fieldChild(callExpr, "function").foreach { funcNode =>
          val callee = resolveCalleeName(funcNode)
          callee.foreach { name =>
            if (!TypeScriptBuiltins.contains(name) && !TypeScriptKeywords.contains(name) &&
                name != fileName && !relationships.exists(r =>
                  r.srcName == fileName && r.dstName == name && r.predicate == "CALLS")) {
              relationships = relationships :+ ParsedRelationship(fileName, name, "CALLS")
            }
          }
        }
      }
    }

    private def resolveCalleeName(funcNode: TSNode): Option[String] = {
      funcNode.getType() match {
        case "identifier" =>
          Some(nodeText(funcNode, source))
        case "member_expression" =>
          // e.g., this.method(), obj.method() — extract the property name
          fieldChild(funcNode, "property").map(n => nodeText(n, source))
        case "call_expression" =>
          // Chained: foo.bar().baz() — take the outermost function
          fieldChild(funcNode, "function").flatMap(resolveCalleeName)
        case _ =>
          None
      }
    }

    // --- Helpers ---

    private def extractFirstLine(node: TSNode): String = {
      val text = nodeText(node, source)
      text.split("\n").head
    }

    private def extractVisibility(node: TSNode): String = {
      // Check for accessibility_modifier child
      val modifier = allChildren(node).find(c =>
        c.getType() == "accessibility_modifier" ||
        c.getType() == "private" || c.getType() == "public" || c.getType() == "protected"
      )
      modifier match {
        case Some(m) =>
          val text = nodeText(m, source).trim
          if (text == "private") "private"
          else if (text == "protected") "protected"
          else "public"
        case None =>
          // Also check the first line text
          val firstLine = extractFirstLine(node).trim
          if (firstLine.startsWith("private ") || firstLine.startsWith("private\t")) "private"
          else if (firstLine.startsWith("protected ") || firstLine.startsWith("protected\t")) "protected"
          else "public"
      }
    }
  }

  // --- Shared constants (reused from TypeScriptParser) ---

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
    "map", "filter", "reduce", "forEach", "sort", "find", "some", "every",
    "includes", "indexOf", "slice", "splice", "push", "pop", "shift", "unshift",
    "concat", "join", "flat", "flatMap", "fill", "from",
    "split", "replace", "trim", "toUpperCase", "toLowerCase", "substring",
    "charAt", "startsWith", "endsWith", "padStart", "padEnd", "match", "test",
    "keys", "values", "entries", "assign", "create", "freeze",
    "defineProperty", "getOwnPropertyNames", "hasOwnProperty",
    "then", "catch", "finally", "all", "race", "resolve", "reject"
  )
}
